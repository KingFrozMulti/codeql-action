import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { promisify } from "util";

import * as core from "@actions/core";
import checkDiskSpace from "check-disk-space";
import del from "del";
import getFolderSize from "get-folder-size";
import * as semver from "semver";

import * as apiCompatibility from "./api-compatibility.json";
import type { CodeQL, VersionInfo } from "./codeql";
import type { Config, Pack } from "./config-utils";
import { EnvVar } from "./environment";
import { Language } from "./languages";
import { Logger } from "./logging";

/**
 * Specifies bundle versions that are known to be broken
 * and will not be used if found in the toolcache.
 */
const BROKEN_VERSIONS = ["0.0.0-20211207"];

/**
 * The URL for github.com.
 */
export const GITHUB_DOTCOM_URL = "https://github.com";

/**
 * Default name of the debugging artifact.
 */
export const DEFAULT_DEBUG_ARTIFACT_NAME = "debug-artifacts";

/**
 * Default name of the database in the debugging artifact.
 */
export const DEFAULT_DEBUG_DATABASE_NAME = "db";

/**
 * The default fraction of the total RAM above 8 GB that should be reserved for the system.
 */
const DEFAULT_RESERVED_RAM_SCALING_FACTOR = 0.05;

/**
 * The minimum amount of memory imposed by a cgroup limit that we will consider. Memory limits below
 * this amount are ignored.
 */
const MINIMUM_CGROUP_MEMORY_LIMIT_BYTES = 1024 * 1024;

export interface SarifFile {
  version?: string | null;
  runs: SarifRun[];
}

export interface SarifRun {
  tool?: {
    driver?: {
      name?: string;
      semanticVersion?: string;
    };
  };
  automationDetails?: {
    id?: string;
  };
  artifacts?: string[];
  invocations?: SarifInvocation[];
  results?: SarifResult[];
}

export interface SarifInvocation {
  toolExecutionNotifications?: SarifNotification[];
}

export interface SarifResult {
  ruleId?: string;
  rule?: {
    id?: string;
  };
  message?: {
    text?: string;
  };
  locations: Array<{
    physicalLocation: {
      artifactLocation: {
        uri: string;
      };
      region?: {
        startLine?: number;
      };
    };
  }>;
  partialFingerprints: {
    primaryLocationLineHash?: string;
  };
}

export interface SarifNotification {
  locations?: SarifLocation[];
}

export interface SarifLocation {
  physicalLocation?: {
    artifactLocation?: {
      uri?: string;
    };
  };
}

/**
 * Get the extra options for the codeql commands.
 */
export function getExtraOptionsEnvParam(): object {
  const varName = "CODEQL_ACTION_EXTRA_OPTIONS";
  const raw = process.env[varName];
  if (raw === undefined || raw.length === 0) {
    return {};
  }
  try {
    return JSON.parse(raw);
  } catch (unwrappedError) {
    const error = wrapError(unwrappedError);
    throw new Error(
      `${varName} environment variable is set, but does not contain valid JSON: ${error.message}`,
    );
  }
}

/**
 * Get the array of all the tool names contained in the given sarif contents.
 *
 * Returns an array of unique string tool names.
 */
export function getToolNames(sarif: SarifFile): string[] {
  const toolNames = {};

  for (const run of sarif.runs || []) {
    const tool = run.tool || {};
    const driver = tool.driver || {};
    if (typeof driver.name === "string" && driver.name.length > 0) {
      toolNames[driver.name] = true;
    }
  }

  return Object.keys(toolNames);
}

// Creates a random temporary directory, runs the given body, and then deletes the directory.
// Mostly intended for use within tests.
export async function withTmpDir<T>(
  body: (tmpDir: string) => Promise<T>,
): Promise<T> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codeql-action-"));
  const result = await body(tmpDir);
  await del(tmpDir, { force: true });
  return result;
}

/**
 * Gets an OS-specific amount of memory (in MB) to reserve for OS processes
 * when the user doesn't explicitly specify a memory setting.
 * This is a heuristic to avoid OOM errors (exit code 137 / SIGKILL)
 * from committing too much of the available memory to CodeQL.
 * @returns number
 */
function getSystemReservedMemoryMegaBytes(
  totalMemoryMegaBytes: number,
  platform: string,
): number {
  // Windows needs more memory for OS processes.
  const fixedAmount = 1024 * (platform === "win32" ? 1.5 : 1);

  // Reserve an additional percentage of the amount of memory above 8 GB, since the amount used by
  // the kernel for page tables scales with the size of physical memory.
  const scaledAmount =
    getReservedRamScaleFactor() * Math.max(totalMemoryMegaBytes - 8 * 1024, 0);
  return fixedAmount + scaledAmount;
}

function getReservedRamScaleFactor(): number {
  const envVar = Number.parseInt(
    process.env[EnvVar.SCALING_RESERVED_RAM_PERCENTAGE] || "",
    10,
  );
  if (envVar < 0 || envVar > 100 || Number.isNaN(envVar)) {
    return DEFAULT_RESERVED_RAM_SCALING_FACTOR;
  }
  return envVar / 100;
}

/**
 * Get the value of the codeql `--ram` flag as configured by the `ram` input.
 * If no value was specified, the total available memory will be used minus a
 * threshold reserved for the OS.
 *
 * @returns {number} the amount of RAM to use, in megabytes
 */
export function getMemoryFlagValueForPlatform(
  userInput: string | undefined,
  totalMemoryBytes: number,
  platform: string,
): number {
  let memoryToUseMegaBytes: number;
  if (userInput) {
    memoryToUseMegaBytes = Number(userInput);
    if (Number.isNaN(memoryToUseMegaBytes) || memoryToUseMegaBytes <= 0) {
      throw new Error(`Invalid RAM setting "${userInput}", specified.`);
    }
  } else {
    const totalMemoryMegaBytes = totalMemoryBytes / (1024 * 1024);
    const reservedMemoryMegaBytes = getSystemReservedMemoryMegaBytes(
      totalMemoryMegaBytes,
      platform,
    );
    memoryToUseMegaBytes = totalMemoryMegaBytes - reservedMemoryMegaBytes;
  }
  return Math.floor(memoryToUseMegaBytes);
}

/**
 * Get the total amount of memory available to the Action, taking into account constraints imposed
 * by cgroups on Linux.
 */
function getTotalMemoryBytes(logger: Logger): number {
  const limits = [os.totalmem()];
  if (os.platform() === "linux") {
    limits.push(
      ...[
        "/sys/fs/cgroup/memory/memory.limit_in_bytes",
        "/sys/fs/cgroup/memory.max",
      ]
        .map((file) => getCgroupMemoryLimitBytes(file, logger))
        .filter((limit) => limit !== undefined)
        .map((limit) => limit as number),
    );
  }
  const limit = Math.min(...limits);
  logger.debug(
    `While resolving RAM, determined that the total memory available to the Action is ${
      limit / (1024 * 1024)
    } MiB.`,
  );
  return limit;
}

/**
 * Gets the number of bytes of available memory specified by the cgroup limit file at the given path.
 *
 * May be greater than the total memory reported by the operating system if there is no cgroup limit.
 */
function getCgroupMemoryLimitBytes(
  limitFile: string,
  logger: Logger,
): number | undefined {
  if (!fs.existsSync(limitFile)) {
    logger.debug(
      `While resolving RAM, did not find a cgroup memory limit at ${limitFile}.`,
    );
    return undefined;
  }

  const limit = Number(fs.readFileSync(limitFile, "utf8"));

  if (!Number.isInteger(limit)) {
    logger.debug(
      `While resolving RAM, ignored the file ${limitFile} that may contain a cgroup memory limit ` +
        "as this file did not contain an integer.",
    );
    return undefined;
  }

  const displayLimit = `${Math.floor(limit / (1024 * 1024))} MiB`;
  if (limit > os.totalmem()) {
    logger.debug(
      `While resolving RAM, ignored the file ${limitFile} that may contain a cgroup memory limit as ` +
        `its contents ${displayLimit} were greater than the total amount of system memory.`,
    );
    return undefined;
  }

  if (limit < MINIMUM_CGROUP_MEMORY_LIMIT_BYTES) {
    logger.info(
      `While resolving RAM, ignored a cgroup limit of ${displayLimit} in ${limitFile} as it was below ${
        MINIMUM_CGROUP_MEMORY_LIMIT_BYTES / (1024 * 1024)
      } MiB.`,
    );
    return undefined;
  }

  logger.info(
    `While resolving RAM, found a cgroup limit of ${displayLimit} in ${limitFile}.`,
  );
  return limit;
}

/**
 * Get the value of the codeql `--ram` flag as configured by the `ram` input.
 * If no value was specified, the total available memory will be used minus a
 * threshold reserved for the OS.
 *
 * @returns {number} the amount of RAM to use, in megabytes
 */
export function getMemoryFlagValue(
  userInput: string | undefined,
  logger: Logger,
): number {
  return getMemoryFlagValueForPlatform(
    userInput,
    getTotalMemoryBytes(logger),
    process.platform,
  );
}

/**
 * Get the codeql `--ram` flag as configured by the `ram` input. If no value was
 * specified, the total available memory will be used minus a threshold
 * reserved for the OS.
 *
 * @returns string
 */
export function getMemoryFlag(
  userInput: string | undefined,
  logger: Logger,
): string {
  const megabytes = getMemoryFlagValue(userInput, logger);
  return `--ram=${megabytes}`;
}

/**
 * Get the codeql flag to specify whether to add code snippets to the sarif file.
 *
 * @returns string
 */
export function getAddSnippetsFlag(
  userInput: string | boolean | undefined,
): string {
  if (typeof userInput === "string") {
    // have to process specifically because any non-empty string is truthy
    userInput = userInput.toLowerCase() === "true";
  }
  return userInput ? "--sarif-add-snippets" : "--no-sarif-add-snippets";
}

/**
 * Get the value of the codeql `--threads` flag specified for the `threads`
 * input. If no value was specified, all available threads will be used.
 *
 * The value will be capped to the number of available CPUs.
 *
 * @returns {number}
 */
export function getThreadsFlagValue(
  userInput: string | undefined,
  logger: Logger,
): number {
  let numThreads: number;
  const maxThreads = os.cpus().length;
  if (userInput) {
    numThreads = Number(userInput);
    if (Number.isNaN(numThreads)) {
      throw new Error(`Invalid threads setting "${userInput}", specified.`);
    }
    if (numThreads > maxThreads) {
      logger.info(
        `Clamping desired number of threads (${numThreads}) to max available (${maxThreads}).`,
      );
      numThreads = maxThreads;
    }
    const minThreads = -maxThreads;
    if (numThreads < minThreads) {
      logger.info(
        `Clamping desired number of free threads (${numThreads}) to max available (${minThreads}).`,
      );
      numThreads = minThreads;
    }
  } else {
    // Default to using all threads
    numThreads = maxThreads;
  }
  return numThreads;
}

/**
 * Get the codeql `--threads` flag specified for the `threads` input.
 * If no value was specified, all available threads will be used.
 *
 * The value will be capped to the number of available CPUs.
 *
 * @returns string
 */
export function getThreadsFlag(
  userInput: string | undefined,
  logger: Logger,
): string {
  return `--threads=${getThreadsFlagValue(userInput, logger)}`;
}

/**
 * Get the path where the CodeQL database for the given language lives.
 */
export function getCodeQLDatabasePath(config: Config, language: Language) {
  return path.resolve(config.dbLocation, language);
}

/**
 * Parses user input of a github.com or GHES URL to a canonical form.
 * Removes any API prefix or suffix if one is present.
 */
export function parseGitHubUrl(inputUrl: string): string {
  const originalUrl = inputUrl;
  if (inputUrl.indexOf("://") === -1) {
    inputUrl = `https://${inputUrl}`;
  }
  if (!inputUrl.startsWith("http://") && !inputUrl.startsWith("https://")) {
    throw new Error(`"${originalUrl}" is not a http or https URL`);
  }

  let url: URL;
  try {
    url = new URL(inputUrl);
  } catch (e) {
    throw new Error(`"${originalUrl}" is not a valid URL`);
  }

  // If we detect this is trying to be to github.com
  // then return with a fixed canonical URL.
  if (url.hostname === "github.com" || url.hostname === "api.github.com") {
    return GITHUB_DOTCOM_URL;
  }

  // Remove the API prefix if it's present
  if (url.pathname.indexOf("/api/v3") !== -1) {
    url.pathname = url.pathname.substring(0, url.pathname.indexOf("/api/v3"));
  }
  // Also consider subdomain isolation on GHES
  if (url.hostname.startsWith("api.")) {
    url.hostname = url.hostname.substring(4);
  }

  // Normalise path to having a trailing slash for consistency
  if (!url.pathname.endsWith("/")) {
    url.pathname = `${url.pathname}/`;
  }

  return url.toString();
}

const CODEQL_ACTION_WARNED_ABOUT_VERSION_ENV_VAR =
  "CODEQL_ACTION_WARNED_ABOUT_VERSION";

let hasBeenWarnedAboutVersion = false;

export enum GitHubVariant {
  DOTCOM,
  GHES,
  GHAE,
  GHE_DOTCOM,
}
export type GitHubVersion =
  | { type: GitHubVariant.DOTCOM }
  | { type: GitHubVariant.GHAE }
  | { type: GitHubVariant.GHE_DOTCOM }
  | { type: GitHubVariant.GHES; version: string };

export function checkGitHubVersionInRange(
  version: GitHubVersion,
  logger: Logger,
) {
  if (hasBeenWarnedAboutVersion || version.type !== GitHubVariant.GHES) {
    return;
  }

  const disallowedAPIVersionReason = apiVersionInRange(
    version.version,
    apiCompatibility.minimumVersion,
    apiCompatibility.maximumVersion,
  );

  if (
    disallowedAPIVersionReason === DisallowedAPIVersionReason.ACTION_TOO_OLD
  ) {
    logger.warning(
      `The CodeQL Action version you are using is too old to be compatible with GitHub Enterprise ${version.version}. If you experience issues, please upgrade to a more recent version of the CodeQL Action.`,
    );
  }
  if (
    disallowedAPIVersionReason === DisallowedAPIVersionReason.ACTION_TOO_NEW
  ) {
    logger.warning(
      `GitHub Enterprise ${version.version} is too old to be compatible with this version of the CodeQL Action. If you experience issues, please upgrade to a more recent version of GitHub Enterprise or use an older version of the CodeQL Action.`,
    );
  }
  hasBeenWarnedAboutVersion = true;
  core.exportVariable(CODEQL_ACTION_WARNED_ABOUT_VERSION_ENV_VAR, true);
}

export enum DisallowedAPIVersionReason {
  ACTION_TOO_OLD,
  ACTION_TOO_NEW,
}

export function apiVersionInRange(
  version: string,
  minimumVersion: string,
  maximumVersion: string,
): DisallowedAPIVersionReason | undefined {
  if (!semver.satisfies(version, `>=${minimumVersion}`)) {
    return DisallowedAPIVersionReason.ACTION_TOO_NEW;
  }
  if (!semver.satisfies(version, `<=${maximumVersion}`)) {
    return DisallowedAPIVersionReason.ACTION_TOO_OLD;
  }
  return undefined;
}

/**
 * This error is used to indicate a runtime failure of an exhaustivity check enforced at compile time.
 */
class ExhaustivityCheckingError extends Error {
  constructor(public expectedExhaustiveValue: never) {
    super("Internal error: exhaustivity checking failure");
  }
}

/**
 * Used to perform compile-time exhaustivity checking on a value.  This function will not be executed at runtime unless
 * the type system has been subverted.
 */
export function assertNever(value: never): never {
  throw new ExhaustivityCheckingError(value);
}

/**
 * Set some initial environment variables that we can set even without
 * knowing what version of CodeQL we're running.
 */
export function initializeEnvironment(version: string) {
  core.exportVariable(String(EnvVar.FEATURE_MULTI_LANGUAGE), "false");
  core.exportVariable(String(EnvVar.FEATURE_SANDWICH), "false");
  core.exportVariable(String(EnvVar.FEATURE_SARIF_COMBINE), "true");
  core.exportVariable(String(EnvVar.FEATURE_WILL_UPLOAD), "true");
  core.exportVariable(String(EnvVar.VERSION), version);
}

/**
 * Get an environment parameter, but throw an error if it is not set.
 */
export function getRequiredEnvParam(paramName: string): string {
  const value = process.env[paramName];
  if (value === undefined || value.length === 0) {
    throw new Error(`${paramName} environment variable must be set`);
  }
  return value;
}

export class HTTPError extends Error {
  public status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

/**
 * An Error class that indicates an error that occurred due to
 * a misconfiguration of the action or the CodeQL CLI.
 */
export class UserError extends Error {
  constructor(message: string) {
    super(message);
  }
}

export function isHTTPError(arg: any): arg is HTTPError {
  return arg?.status !== undefined && Number.isInteger(arg.status);
}

let cachedCodeQlVersion: undefined | VersionInfo = undefined;

export function cacheCodeQlVersion(version: VersionInfo): void {
  if (cachedCodeQlVersion !== undefined) {
    throw new Error("cacheCodeQlVersion() should be called only once");
  }
  cachedCodeQlVersion = version;
}

export function getCachedCodeQlVersion(): undefined | VersionInfo {
  return cachedCodeQlVersion;
}

export async function codeQlVersionAbove(
  codeql: CodeQL,
  requiredVersion: string,
): Promise<boolean> {
  return semver.gte((await codeql.getVersion()).version, requiredVersion);
}

// Create a bundle for the given DB, if it doesn't already exist
export async function bundleDb(
  config: Config,
  language: Language,
  codeql: CodeQL,
  dbName: string,
) {
  const databasePath = getCodeQLDatabasePath(config, language);
  const databaseBundlePath = path.resolve(config.dbLocation, `${dbName}.zip`);
  // For a tiny bit of added safety, delete the file if it exists.
  // The file is probably from an earlier call to this function, either
  // as part of this action step or a previous one, but it could also be
  // from somewhere else or someone trying to make the action upload a
  // non-database file.
  if (fs.existsSync(databaseBundlePath)) {
    await del(databaseBundlePath, { force: true });
  }
  await codeql.databaseBundle(databasePath, databaseBundlePath, dbName);
  return databaseBundlePath;
}

/**
 * @param milliseconds time to delay
 * @param opts options
 * @param opts.allowProcessExit if true, the timer will not prevent the process from exiting
 */
export async function delay(
  milliseconds: number,
  { allowProcessExit }: { allowProcessExit: boolean },
) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    if (allowProcessExit) {
      // Immediately `unref` the timer such that it only prevents the process from exiting if the
      // surrounding promise is being awaited.
      timer.unref();
    }
  });
}

export function isGoodVersion(versionSpec: string) {
  return !BROKEN_VERSIONS.includes(versionSpec);
}

/**
 * Checks whether the CodeQL CLI supports the `--expect-discarded-cache` command-line flag.
 */
export async function supportExpectDiscardedCache(
  codeQL: CodeQL,
): Promise<boolean> {
  return codeQlVersionAbove(codeQL, "2.12.1");
}

/*
 * Returns whether we are in test mode.
 *
 * In test mode, we don't upload SARIF results or status reports to the GitHub API.
 */
export function isInTestMode(): boolean {
  return process.env[EnvVar.TEST_MODE] === "true";
}

/*
 * Returns whether the path in the argument represents an existing directory.
 */
export function doesDirectoryExist(dirPath: string): boolean {
  try {
    const stats = fs.lstatSync(dirPath);
    return stats.isDirectory();
  } catch (e) {
    return false;
  }
}

/**
 * Returns a recursive list of files in a given directory.
 */
export function listFolder(dir: string): string[] {
  if (!doesDirectoryExist(dir)) {
    return [];
  }
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  let files: string[] = [];
  for (const entry of entries) {
    if (entry.isFile()) {
      files.push(path.resolve(dir, entry.name));
    } else if (entry.isDirectory()) {
      files = files.concat(listFolder(path.resolve(dir, entry.name)));
    }
  }
  return files;
}

/**
 * Get the size a folder in bytes. This will log any filesystem errors
 * as a warning and then return undefined.
 *
 * @param cacheDir A directory to get the size of.
 * @param logger A logger to log any errors to.
 * @returns The size in bytes of the folder, or undefined if errors occurred.
 */
export async function tryGetFolderBytes(
  cacheDir: string,
  logger: Logger,
): Promise<number | undefined> {
  try {
    return await promisify<string, number>(getFolderSize)(cacheDir);
  } catch (e) {
    logger.warning(`Encountered an error while getting size of folder: ${e}`);
    return undefined;
  }
}

let hadTimeout = false;

/**
 * Run a promise for a given amount of time, and if it doesn't resolve within
 * that time, call the provided callback and then return undefined. Due to the
 * limitation outlined below, using this helper function is not recommended
 * unless there is no other option for adding a timeout (e.g. the code that
 * would need the timeout added is an external library).
 *
 * Important: This does NOT cancel the original promise, so that promise will
 * continue in the background even after the timeout has expired. If the
 * original promise hangs, then this will prevent the process terminating.
 * If a timeout has occurred then the global hadTimeout variable will get set
 * to true, and the caller is responsible for forcing the process to exit
 * if this is the case by calling the `checkForTimeout` function at the end
 * of execution.
 *
 * @param timeoutMs The timeout in milliseconds.
 * @param promise The promise to run.
 * @param onTimeout A callback to call if the promise times out.
 * @returns The result of the promise, or undefined if the promise times out.
 */
export async function withTimeout<T>(
  timeoutMs: number,
  promise: Promise<T>,
  onTimeout: () => void,
): Promise<T | undefined> {
  let finished = false;
  const mainTask = async () => {
    const result = await promise;
    finished = true;
    return result;
  };
  const timeoutTask = async () => {
    await delay(timeoutMs, { allowProcessExit: true });
    if (!finished) {
      // Workaround: While the promise racing below will allow the main code
      // to continue, the process won't normally exit until the asynchronous
      // task in the background has finished. We set this variable to force
      // an exit at the end of our code when `checkForTimeout` is called.
      hadTimeout = true;
      onTimeout();
    }
    return undefined;
  };
  return await Promise.race([mainTask(), timeoutTask()]);
}

/**
 * Check if the global hadTimeout variable has been set, and if so then
 * exit the process to ensure any background tasks that are still running
 * are killed. This should be called at the end of execution if the
 * `withTimeout` function has been used.
 */
export async function checkForTimeout() {
  if (hadTimeout === true) {
    core.info(
      "A timeout occurred, force exiting the process after 30 seconds to prevent hanging.",
    );
    await delay(30_000, { allowProcessExit: true });
    process.exit();
  }
}

/**
 * This function implements a heuristic to determine whether the
 * runner we are on is hosted by GitHub. It does this by checking
 * the name of the runner against the list of known GitHub-hosted
 * runner names. It also checks for the presence of a toolcache
 * directory with the name hostedtoolcache which is present on
 * GitHub-hosted runners.
 *
 * @returns true iff the runner is hosted by GitHub
 */
export function isHostedRunner() {
  return (
    // Name of the runner on hosted Windows runners
    process.env["RUNNER_NAME"]?.includes("Hosted Agent") ||
    // Name of the runner on hosted POSIX runners
    process.env["RUNNER_NAME"]?.includes("GitHub Actions") ||
    // Segment of the path to the tool cache on all hosted runners
    process.env["RUNNER_TOOL_CACHE"]?.includes("hostedtoolcache")
  );
}

export function parseMatrixInput(
  matrixInput: string | undefined,
): { [key: string]: string } | undefined {
  if (matrixInput === undefined || matrixInput === "null") {
    return undefined;
  }
  return JSON.parse(matrixInput);
}

function removeDuplicateLocations(locations: SarifLocation[]): SarifLocation[] {
  const newJsonLocations = new Set<string>();
  return locations.filter((location) => {
    const jsonLocation = JSON.stringify(location);
    if (!newJsonLocations.has(jsonLocation)) {
      newJsonLocations.add(jsonLocation);
      return true;
    }
    return false;
  });
}

export function fixInvalidNotifications(
  sarif: SarifFile,
  logger: Logger,
): SarifFile {
  if (!Array.isArray(sarif.runs)) {
    return sarif;
  }

  // Ensure that the array of locations for each SARIF notification contains unique locations.
  // This is a workaround for a bug in the CodeQL CLI that causes duplicate locations to be
  // emitted in some cases.
  let numDuplicateLocationsRemoved = 0;

  const newSarif = {
    ...sarif,
    runs: sarif.runs.map((run) => {
      if (
        run.tool?.driver?.name !== "CodeQL" ||
        !Array.isArray(run.invocations)
      ) {
        return run;
      }
      return {
        ...run,
        invocations: run.invocations.map((invocation) => {
          if (!Array.isArray(invocation.toolExecutionNotifications)) {
            return invocation;
          }
          return {
            ...invocation,
            toolExecutionNotifications:
              invocation.toolExecutionNotifications.map((notification) => {
                if (!Array.isArray(notification.locations)) {
                  return notification;
                }
                const newLocations = removeDuplicateLocations(
                  notification.locations,
                );
                numDuplicateLocationsRemoved +=
                  notification.locations.length - newLocations.length;
                return {
                  ...notification,
                  locations: newLocations,
                };
              }),
          };
        }),
      };
    }),
  };

  if (numDuplicateLocationsRemoved > 0) {
    logger.info(
      `Removed ${numDuplicateLocationsRemoved} duplicate locations from SARIF notification ` +
        "objects.",
    );
  } else {
    logger.debug("No duplicate locations found in SARIF notification objects.");
  }
  return newSarif;
}

/**
 * Removes duplicates from the sarif file.
 *
 * When `CODEQL_ACTION_DISABLE_DUPLICATE_LOCATION_FIX` is set to true, this will
 * simply rename the input file to the output file. Otherwise, it will parse the
 * input file as JSON, remove duplicate locations from the SARIF notification
 * objects, and write the result to the output file.
 *
 * For context, see documentation of:
 * `CODEQL_ACTION_DISABLE_DUPLICATE_LOCATION_FIX`. */
export function fixInvalidNotificationsInFile(
  inputPath: string,
  outputPath: string,
  logger: Logger,
): void {
  if (process.env[EnvVar.DISABLE_DUPLICATE_LOCATION_FIX] === "true") {
    logger.info(
      "SARIF notification object duplicate location fix disabled by the " +
        `${EnvVar.DISABLE_DUPLICATE_LOCATION_FIX} environment variable.`,
    );
    fs.renameSync(inputPath, outputPath);
  } else {
    let sarif = JSON.parse(fs.readFileSync(inputPath, "utf8")) as SarifFile;
    sarif = fixInvalidNotifications(sarif, logger);
    fs.writeFileSync(outputPath, JSON.stringify(sarif));
  }
}

export function wrapError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

export function prettyPrintPack(pack: Pack) {
  return `${pack.name}${pack.version ? `@${pack.version}` : ""}${
    pack.path ? `:${pack.path}` : ""
  }`;
}

export interface DiskUsage {
  numAvailableBytes: number;
  numTotalBytes: number;
}

export async function checkDiskUsage(logger?: Logger): Promise<DiskUsage> {
  const diskUsage = await checkDiskSpace(
    getRequiredEnvParam("GITHUB_WORKSPACE"),
  );
  const gbInBytes = 1024 * 1024 * 1024;
  if (logger && diskUsage.free < 2 * gbInBytes) {
    const message =
      "The Actions runner is running low on disk space " +
      `(${(diskUsage.free / gbInBytes).toPrecision(4)} GB available).`;
    if (process.env[EnvVar.HAS_WARNED_ABOUT_DISK_SPACE] !== "true") {
      logger.warning(message);
    } else {
      logger.debug(message);
    }
    core.exportVariable(EnvVar.HAS_WARNED_ABOUT_DISK_SPACE, "true");
  }
  return {
    numAvailableBytes: diskUsage.free,
    numTotalBytes: diskUsage.size,
  };
}
