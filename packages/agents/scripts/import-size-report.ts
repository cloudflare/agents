import { build, version as esbuildVersion } from "esbuild";
import { builtinModules } from "node:module";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  resolve
} from "node:path";
import { gzipSync } from "node:zlib";

const SNAPSHOT_KIND = "agents-import-size-snapshot";
const REPORT_KIND = "agents-import-size-report";
const SCHEMA_VERSION = 1;
const MAX_MEASUREMENTS = 1_000;
const MAX_TEXT_LENGTH = 256;

/** A minified consumer bundle for one runtime export. */
export type ImportSizeMeasurement = {
  readonly entryPoint: string;
  readonly exportName: string;
  readonly bytes: number;
  readonly gzipBytes: number;
};

/** A deterministic set of consumer import measurements for one package revision. */
export type ImportSizeSnapshot = {
  readonly schemaVersion: 1;
  readonly kind: "agents-import-size-snapshot";
  readonly packageName: string;
  readonly packageVersion: string;
  readonly revision: string;
  readonly bundler: {
    readonly name: "esbuild";
    readonly version: string;
  };
  readonly measurements: ReadonlyArray<ImportSizeMeasurement>;
};

/** The colour assigned to one import comparison. */
export type ImportSizeChangeStatus =
  | "red"
  | "yellow"
  | "green"
  | "unchanged"
  | "new"
  | "removed";

/** A base-to-head comparison for one runtime export. */
export type ImportSizeChange = {
  readonly entryPoint: string;
  readonly exportName: string;
  readonly status: ImportSizeChangeStatus;
  readonly base?: ImportSizeMeasurement;
  readonly head?: ImportSizeMeasurement;
  readonly delta?: {
    readonly bytes: number;
    readonly gzipBytes: number;
    readonly gzipPercent: number | null;
  };
};

/** Counts of import changes by report colour. */
export type ImportSizeSummary = {
  readonly red: number;
  readonly yellow: number;
  readonly green: number;
  readonly unchanged: number;
  readonly new: number;
  readonly removed: number;
  readonly total: number;
};

/** A PR comparison consumed by CI and the Agent Think GitHub App. */
export type ImportSizeReport = {
  readonly schemaVersion: 1;
  readonly kind: "agents-import-size-report";
  readonly repository: string;
  readonly packageName: string;
  readonly packageVersions: {
    readonly base: string;
    readonly head: string;
  };
  readonly pullRequestNumber: number;
  readonly workflowRunId: number;
  readonly workflowRunAttempt: number;
  readonly baseSha: string;
  readonly headSha: string;
  readonly thresholdPercent: number;
  readonly metric: "minified-gzip";
  readonly overall: "red" | "yellow" | "green" | "unchanged";
  readonly gate: "pass" | "fail";
  readonly summary: ImportSizeSummary;
  readonly changes: ReadonlyArray<ImportSizeChange>;
};

/** A parsed value or a tagged parse failure. */
export type ParseResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: InvalidImportSizeData };

/** Indicates that an import-size snapshot or report did not match its schema. */
export class InvalidImportSizeData extends Error {
  readonly _tag = "InvalidImportSizeData" as const;

  /**
   * Create a schema error.
   *
   * @param location - The field or file that failed parsing.
   * @param reason - A safe description of the schema mismatch.
   */
  constructor(
    readonly location: string,
    readonly reason: string
  ) {
    super(`Invalid import-size data at ${location}: ${reason}`);
  }
}

type PackageManifest = {
  readonly name: string;
  readonly version: string;
  readonly exports: Readonly<Record<string, unknown>>;
};

type MeasurePackageImportsOptions = {
  readonly packageDirectory: string;
  readonly revision: string;
};

type CompareImportSizeSnapshotsOptions = {
  readonly repository: string;
  readonly pullRequestNumber: number;
  readonly workflowRunId: number;
  readonly workflowRunAttempt: number;
  readonly thresholdPercent: number;
};

/**
 * Bundle each runtime export from a built package as a standalone consumer import.
 *
 * @param options - Package path and source revision recorded in the snapshot.
 * @returns A stable snapshot sorted by entry point and export name.
 */
export async function measurePackageImports(
  options: MeasurePackageImportsOptions
): Promise<ImportSizeSnapshot> {
  const packageDirectory = resolve(options.packageDirectory);
  const manifest = await readPackageManifest(packageDirectory);
  const consumerDirectory = await mkdtemp(
    join(tmpdir(), "agents-import-sizes-")
  );

  try {
    await linkPackageForConsumer(
      consumerDirectory,
      manifest.name,
      packageDirectory
    );

    const measurements: ImportSizeMeasurement[] = [];
    const exportEntries = Object.entries(manifest.exports).sort(
      ([left], [right]) => left.localeCompare(right)
    );

    for (const [subpath, exportTarget] of exportEntries) {
      const importTarget = getImportTarget(exportTarget);
      if (importTarget === null) continue;

      const builtEntry = resolvePackageTarget(packageDirectory, importTarget);
      const exportNames = await discoverRuntimeExports(builtEntry);
      if (exportNames.length === 0) continue;

      const entryPoint = packageImportPath(manifest.name, subpath);
      const entryMeasurements = await measureEntryPointExports({
        consumerDirectory,
        entryPoint,
        exportNames
      });
      measurements.push(...entryMeasurements);
    }

    measurements.sort(compareMeasurementIdentity);
    assertUniqueMeasurements(measurements);

    if (measurements.length > MAX_MEASUREMENTS) {
      throw new Error(
        `Import-size snapshot has ${measurements.length} measurements; maximum is ${MAX_MEASUREMENTS}`
      );
    }

    return {
      schemaVersion: SCHEMA_VERSION,
      kind: SNAPSHOT_KIND,
      packageName: manifest.name,
      packageVersion: manifest.version,
      revision: options.revision,
      bundler: {
        name: "esbuild",
        version: esbuildVersion
      },
      measurements
    };
  } finally {
    await rm(consumerDirectory, { force: true, recursive: true });
  }
}

/**
 * Compare base and head import snapshots using minified gzip bytes.
 *
 * @param base - Snapshot measured from the pull request base revision.
 * @param head - Snapshot measured from the pull request head revision.
 * @param options - Pull request identity and failure threshold.
 * @returns A structured report whose worst import controls the overall colour.
 */
export function compareImportSizeSnapshots(
  base: ImportSizeSnapshot,
  head: ImportSizeSnapshot,
  options: CompareImportSizeSnapshotsOptions
): ImportSizeReport {
  if (base.packageName !== head.packageName) {
    throw new Error(
      `Cannot compare ${base.packageName} with ${head.packageName}`
    );
  }
  if (base.bundler.name !== head.bundler.name) {
    throw new Error("Import-size snapshots used different bundlers");
  }
  if (base.bundler.version !== head.bundler.version) {
    throw new Error(
      `Import-size snapshots used different esbuild versions: ${base.bundler.version} and ${head.bundler.version}`
    );
  }
  if (
    !Number.isFinite(options.thresholdPercent) ||
    options.thresholdPercent < 0
  ) {
    throw new Error("Import-size threshold must be a non-negative number");
  }

  const baseByIdentity = indexMeasurements(base.measurements);
  const headByIdentity = indexMeasurements(head.measurements);
  const identities = [
    ...new Set([...baseByIdentity.keys(), ...headByIdentity.keys()])
  ].sort();
  const changes = identities.map((identity) => {
    const baseMeasurement = baseByIdentity.get(identity);
    const headMeasurement = headByIdentity.get(identity);
    return compareMeasurement(
      baseMeasurement,
      headMeasurement,
      options.thresholdPercent
    );
  });
  const summary = summarizeChanges(changes);
  const overall = overallStatus(summary);

  return {
    schemaVersion: SCHEMA_VERSION,
    kind: REPORT_KIND,
    repository: options.repository,
    packageName: head.packageName,
    packageVersions: {
      base: base.packageVersion,
      head: head.packageVersion
    },
    pullRequestNumber: options.pullRequestNumber,
    workflowRunId: options.workflowRunId,
    workflowRunAttempt: options.workflowRunAttempt,
    baseSha: base.revision,
    headSha: head.revision,
    thresholdPercent: options.thresholdPercent,
    metric: "minified-gzip",
    overall,
    gate: overall === "red" ? "fail" : "pass",
    summary,
    changes
  };
}

/**
 * Parse an unknown JSON value as an import-size snapshot.
 *
 * @param value - Unknown JSON input.
 * @returns The parsed snapshot or a tagged schema error.
 */
export function parseImportSizeSnapshot(
  value: unknown
): ParseResult<ImportSizeSnapshot> {
  if (!isRecord(value)) return invalid("snapshot", "expected an object");
  if (value.schemaVersion !== SCHEMA_VERSION) {
    return invalid("snapshot.schemaVersion", `expected ${SCHEMA_VERSION}`);
  }
  if (value.kind !== SNAPSHOT_KIND) {
    return invalid("snapshot.kind", `expected ${SNAPSHOT_KIND}`);
  }
  const packageName = parseBoundedString(value.packageName);
  if (packageName === null) {
    return invalid("snapshot.packageName", "expected a non-empty string");
  }
  const packageVersion = parseBoundedString(value.packageVersion);
  if (packageVersion === null) {
    return invalid("snapshot.packageVersion", "expected a non-empty string");
  }
  const revision = parseBoundedString(value.revision);
  if (revision === null) {
    return invalid("snapshot.revision", "expected a non-empty string");
  }
  if (!isRecord(value.bundler) || value.bundler.name !== "esbuild") {
    return invalid("snapshot.bundler", "expected an esbuild descriptor");
  }
  const bundlerVersion = parseBoundedString(value.bundler.version);
  if (bundlerVersion === null) {
    return invalid("snapshot.bundler.version", "expected a non-empty string");
  }
  if (!Array.isArray(value.measurements)) {
    return invalid("snapshot.measurements", "expected an array");
  }
  if (value.measurements.length > MAX_MEASUREMENTS) {
    return invalid(
      "snapshot.measurements",
      `expected at most ${MAX_MEASUREMENTS} entries`
    );
  }

  const measurements: ImportSizeMeasurement[] = [];
  for (const [index, candidate] of value.measurements.entries()) {
    const parsed = parseMeasurement(
      candidate,
      `snapshot.measurements[${index}]`
    );
    if (!parsed.ok) return parsed;
    measurements.push(parsed.value);
  }
  measurements.sort(compareMeasurementIdentity);

  try {
    assertUniqueMeasurements(measurements);
  } catch (cause: unknown) {
    return invalid(
      "snapshot.measurements",
      cause instanceof Error ? cause.message : "duplicate import identity"
    );
  }

  return {
    ok: true,
    value: {
      schemaVersion: SCHEMA_VERSION,
      kind: SNAPSHOT_KIND,
      packageName,
      packageVersion,
      revision,
      bundler: {
        name: "esbuild",
        version: bundlerVersion
      },
      measurements
    }
  };
}

/**
 * Write stable JSON with a trailing newline, creating parent directories.
 *
 * @param outputPath - Destination path.
 * @param value - JSON-compatible report or snapshot.
 * @returns A promise that settles after the file is written.
 */
export async function writeImportSizeJson(
  outputPath: string,
  value: ImportSizeSnapshot | ImportSizeReport
): Promise<void> {
  const destination = resolve(outputPath);
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function readPackageManifest(
  packageDirectory: string
): Promise<PackageManifest> {
  const manifestPath = join(packageDirectory, "package.json");
  const raw = await readFile(manifestPath, "utf8");
  const value: unknown = JSON.parse(raw);
  if (!isRecord(value)) {
    throw new Error(`${manifestPath} did not contain an object`);
  }
  const name = parseBoundedString(value.name);
  const version = parseBoundedString(value.version);
  if (name === null || version === null || !isRecord(value.exports)) {
    throw new Error(
      `${manifestPath} must define string name/version fields and an exports object`
    );
  }
  return { name, version, exports: value.exports };
}

async function linkPackageForConsumer(
  consumerDirectory: string,
  packageName: string,
  packageDirectory: string
): Promise<void> {
  const packageSegments = packageName.split("/");
  if (
    packageSegments.length === 0 ||
    packageSegments.some(
      (segment) => segment.length === 0 || segment === "." || segment === ".."
    )
  ) {
    throw new Error(`Cannot create a consumer link for package ${packageName}`);
  }
  const packageLink = join(
    consumerDirectory,
    "node_modules",
    ...packageSegments
  );
  await mkdir(dirname(packageLink), { recursive: true });
  await symlink(packageDirectory, packageLink, "dir");
}

function getImportTarget(exportTarget: unknown): string | null {
  if (!isRecord(exportTarget) || typeof exportTarget.import !== "string") {
    return null;
  }
  return exportTarget.import;
}

function resolvePackageTarget(
  packageDirectory: string,
  importTarget: string
): string {
  if (isAbsolute(importTarget)) {
    throw new Error(`Package export target must be relative: ${importTarget}`);
  }
  const resolved = resolve(packageDirectory, importTarget);
  const packagePrefix = `${packageDirectory}/`;
  if (resolved !== packageDirectory && !resolved.startsWith(packagePrefix)) {
    throw new Error(
      `Package export target escaped its package: ${importTarget}`
    );
  }
  return resolved;
}

async function discoverRuntimeExports(
  builtEntry: string
): Promise<ReadonlyArray<string>> {
  const result = await build({
    bundle: false,
    entryPoints: [builtEntry],
    format: "esm",
    logLevel: "silent",
    metafile: true,
    write: false
  });
  if (result.metafile === undefined) {
    throw new Error(`esbuild produced no metafile for ${builtEntry}`);
  }
  const exportNames = Object.values(result.metafile.outputs).flatMap(
    (output) => output.exports
  );
  return [...new Set(exportNames)].sort();
}

function packageImportPath(packageName: string, subpath: string): string {
  if (subpath === ".") return packageName;
  if (!subpath.startsWith("./")) {
    throw new Error(`Unsupported package export subpath: ${subpath}`);
  }
  return `${packageName}/${subpath.slice(2)}`;
}

async function measureEntryPointExports(input: {
  readonly consumerDirectory: string;
  readonly entryPoint: string;
  readonly exportNames: ReadonlyArray<string>;
}): Promise<ReadonlyArray<ImportSizeMeasurement>> {
  const virtualSources = new Map<string, string>();
  const entryPoints = input.exportNames.map((exportName, index) => {
    const virtualPath = `import-size:${index}`;
    virtualSources.set(
      virtualPath,
      exportProbeSource(input.entryPoint, exportName)
    );
    return {
      in: virtualPath,
      out: `probe-${index.toString().padStart(4, "0")}`
    };
  });
  const outputDirectory = join(input.consumerDirectory, "out");
  const result = await build({
    absWorkingDir: input.consumerDirectory,
    bundle: true,
    conditions: ["workerd", "worker", "browser", "import", "module"],
    entryPoints,
    external: ["cloudflare:*", ...nodeBuiltinExternalPaths()],
    format: "esm",
    legalComments: "none",
    logLevel: "silent",
    mainFields: ["browser", "module", "main"],
    minify: true,
    outdir: outputDirectory,
    platform: "browser",
    plugins: [
      {
        name: "import-size-probes",
        setup(context) {
          context.onResolve({ filter: /^import-size:/ }, (args) => ({
            path: args.path,
            namespace: "import-size-probe"
          }));
          context.onLoad(
            { filter: /.*/, namespace: "import-size-probe" },
            (args) => {
              const contents = virtualSources.get(args.path);
              if (contents === undefined) {
                return {
                  errors: [{ text: `Unknown import-size probe ${args.path}` }]
                };
              }
              return {
                contents,
                loader: "js",
                resolveDir: input.consumerDirectory
              };
            }
          );
        }
      }
    ],
    target: "es2021",
    treeShaking: true,
    write: false
  });
  if (result.outputFiles === undefined) {
    throw new Error(`esbuild produced no outputs for ${input.entryPoint}`);
  }

  const measurements: ImportSizeMeasurement[] = [];
  for (const output of result.outputFiles) {
    if (extname(output.path) !== ".js") {
      throw new Error(
        `Import-size probe emitted unsupported asset ${output.path}`
      );
    }
    const probeName = basename(output.path, ".js");
    const index = parseProbeIndex(probeName);
    const exportName = input.exportNames.at(index);
    if (exportName === undefined) {
      throw new Error(`Cannot map import-size output ${output.path}`);
    }
    measurements.push({
      entryPoint: input.entryPoint,
      exportName,
      bytes: output.contents.byteLength,
      gzipBytes: gzipSync(output.contents, { level: 9 }).byteLength
    });
  }

  if (measurements.length !== input.exportNames.length) {
    throw new Error(
      `Expected ${input.exportNames.length} import-size outputs for ${input.entryPoint}, received ${measurements.length}`
    );
  }
  return measurements;
}

function exportProbeSource(entryPoint: string, exportName: string): string {
  const importPath = JSON.stringify(entryPoint);
  if (exportName === "default") {
    return `export { default as measured } from ${importPath};`;
  }
  if (!isJavaScriptIdentifierName(exportName)) {
    throw new Error(`Unsupported runtime export name: ${exportName}`);
  }
  return `export { ${exportName} as measured } from ${importPath};`;
}

function isJavaScriptIdentifierName(value: string): boolean {
  return /^[$_\p{ID_Start}][$\u200c\u200d\p{ID_Continue}]*$/u.test(value);
}

function nodeBuiltinExternalPaths(): ReadonlyArray<string> {
  return [
    ...new Set(
      builtinModules.flatMap((moduleName) => {
        const bareName = moduleName.replace(/^node:/, "");
        return [bareName, `node:${bareName}`];
      })
    )
  ].sort();
}

function parseProbeIndex(probeName: string): number {
  const match = /^probe-(\d+)$/.exec(probeName);
  if (match === null) {
    throw new Error(`Unexpected import-size output name ${probeName}`);
  }
  const index = Number(match[1]);
  if (!Number.isSafeInteger(index) || index < 0) {
    throw new Error(`Invalid import-size output index ${probeName}`);
  }
  return index;
}

function compareMeasurement(
  base: ImportSizeMeasurement | undefined,
  head: ImportSizeMeasurement | undefined,
  thresholdPercent: number
): ImportSizeChange {
  if (base === undefined && head === undefined) {
    throw new Error("Cannot compare an import missing from both snapshots");
  }
  if (base === undefined) {
    if (head === undefined) {
      throw new Error("Cannot compare an import missing from both snapshots");
    }
    return {
      entryPoint: head.entryPoint,
      exportName: head.exportName,
      status: "new",
      head
    };
  }
  if (head === undefined) {
    return {
      entryPoint: base.entryPoint,
      exportName: base.exportName,
      status: "removed",
      base
    };
  }

  const gzipDelta = head.gzipBytes - base.gzipBytes;
  const byteDelta = head.bytes - base.bytes;
  const gzipPercent =
    base.gzipBytes === 0 ? null : (gzipDelta / base.gzipBytes) * 100;
  let status: ImportSizeChangeStatus;
  if (gzipDelta < 0) {
    status = "green";
  } else if (gzipDelta === 0) {
    status = "unchanged";
  } else if (gzipDelta * 100 > base.gzipBytes * thresholdPercent) {
    status = "red";
  } else {
    status = "yellow";
  }

  return {
    entryPoint: head.entryPoint,
    exportName: head.exportName,
    status,
    base,
    head,
    delta: {
      bytes: byteDelta,
      gzipBytes: gzipDelta,
      gzipPercent
    }
  };
}

function summarizeChanges(
  changes: ReadonlyArray<ImportSizeChange>
): ImportSizeSummary {
  const summary: ImportSizeSummary = {
    red: 0,
    yellow: 0,
    green: 0,
    unchanged: 0,
    new: 0,
    removed: 0,
    total: changes.length
  };
  const mutable = {
    red: summary.red,
    yellow: summary.yellow,
    green: summary.green,
    unchanged: summary.unchanged,
    new: summary.new,
    removed: summary.removed
  };
  for (const change of changes) {
    mutable[change.status] += 1;
  }
  return { ...mutable, total: changes.length };
}

function overallStatus(
  summary: ImportSizeSummary
): ImportSizeReport["overall"] {
  if (summary.red > 0) return "red";
  if (summary.yellow > 0) return "yellow";
  if (summary.green > 0 || summary.removed > 0) return "green";
  return "unchanged";
}

function indexMeasurements(
  measurements: ReadonlyArray<ImportSizeMeasurement>
): ReadonlyMap<string, ImportSizeMeasurement> {
  assertUniqueMeasurements(measurements);
  return new Map(
    measurements.map((measurement) => [
      measurementIdentity(measurement),
      measurement
    ])
  );
}

function assertUniqueMeasurements(
  measurements: ReadonlyArray<ImportSizeMeasurement>
): void {
  const identities = new Set<string>();
  for (const measurement of measurements) {
    const identity = measurementIdentity(measurement);
    if (identities.has(identity)) {
      throw new Error(`Duplicate import-size measurement ${identity}`);
    }
    identities.add(identity);
  }
}

function measurementIdentity(measurement: ImportSizeMeasurement): string {
  return `${measurement.entryPoint}\u0000${measurement.exportName}`;
}

function compareMeasurementIdentity(
  left: ImportSizeMeasurement,
  right: ImportSizeMeasurement
): number {
  return measurementIdentity(left).localeCompare(measurementIdentity(right));
}

function parseMeasurement(
  value: unknown,
  location: string
): ParseResult<ImportSizeMeasurement> {
  if (!isRecord(value)) return invalid(location, "expected an object");
  const entryPoint = parseBoundedString(value.entryPoint);
  const exportName = parseBoundedString(value.exportName);
  if (entryPoint === null) {
    return invalid(`${location}.entryPoint`, "expected a non-empty string");
  }
  if (exportName === null) {
    return invalid(`${location}.exportName`, "expected a non-empty string");
  }
  if (!isNonNegativeSafeInteger(value.bytes)) {
    return invalid(`${location}.bytes`, "expected a non-negative integer");
  }
  if (!isNonNegativeSafeInteger(value.gzipBytes)) {
    return invalid(`${location}.gzipBytes`, "expected a non-negative integer");
  }
  return {
    ok: true,
    value: {
      entryPoint,
      exportName,
      bytes: value.bytes,
      gzipBytes: value.gzipBytes
    }
  };
}

function parseBoundedString(value: unknown): string | null {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_TEXT_LENGTH
  ) {
    return null;
  }
  return value;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && typeof value === "number" && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid<T>(location: string, reason: string): ParseResult<T> {
  return {
    ok: false,
    error: new InvalidImportSizeData(location, reason)
  };
}
