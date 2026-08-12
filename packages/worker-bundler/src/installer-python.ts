/*
 * Package resolution logic for Python dynamic workers
 */

import { isTextFile, fetchWithTimeout, DEFAULT_TIMEOUT_MS } from "./common.ts";
import type { InstallResult } from "./common.ts";
import type { FileSystem, FileEntry } from "./file-system";
import { unzipSync } from "fflate";
import { parse as parseToml } from "smol-toml";

// TODO: Update PYODIDE_VERSION once the patch addressing the Python version mismatch for dynamic workers is merged
const PYODIDE_VERSION = "v0.27.5"; // Used for retrieving a pyodide lockfile, which is done per Pyodide version. If incompatible wheels are being served, this may be why
const PYPI_SIMPLE_API = "https://pypi.org/simple";

// Deliberately keeping this minimal
export interface PyprojectToml {
  project?: {
    name: string;
    version: string;
    dependencies?: string[];
  };
}

interface PyPASimpleFile {
  filename: string;
  url: string;
  hashes?: Record<string, string>;
  "requires-python"?: string;
  "core-metadata"?: boolean | { hash?: string; url?: string };
  yanked?: boolean | string;
}

interface PyPASimpleMetadata {
  name: string;
  files: PyPASimpleFile[];
}

// Describes the packages that are available on the Pyodide CDN for a given Pyodide version
interface PyodideLockfile {
  info: {
    abi_version: string;
    arch: "wasm32";
    platform: string;
    python: string;
    version: string;
  };
  packages: Record<string, PyodideLockfilePackage>;
}

interface PyodideLockfilePackage {
  name: string;
  version: string;
  file_name: string;
  sha256: string;
  package_type:
    | "package"
    | "cpython_module"
    | "shared_library"
    | "static_library";
  install_dir: "site" | "dynlib";
  imports: string[];
  depends: string[];
}

interface PyodideWheelInfo {
  package: PyodideLockfilePackage;
  url: string;
  file: PyPASimpleFile;
}

// Making this global so it will only need to be fetched once per invocation
// TODO: Consider caching this somewhere since it's not likely to change between runs
let pyodideLockfile: PyodideLockfile | null = null;

/**
 * Install Python dependencies declared in a pyproject.toml file.
 */
export async function installDependenciesPython(
  fileSystem: FileSystem,
  pyprojectTomlContent: string
): Promise<InstallResult> {
  const result: InstallResult = {
    installed: [],
    warnings: []
  };

  let pyprojectToml: PyprojectToml;
  try {
    pyprojectToml = parseToml(pyprojectTomlContent) as PyprojectToml;
  } catch {
    result.warnings.push("Failed to parse pyproject.toml");
    return result;
  }

  // Collect dependencies to install. We will keep these as full dependency strings.
  const depsToInstall: string[] = pyprojectToml.project?.dependencies ?? [];
  depsToInstall.push("workers-runtime-sdk");

  if (!pyodideLockfile) {
    try {
      pyodideLockfile = await fetchPyodideLockfile(PYODIDE_VERSION);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      result.warnings.push(
        `Could not retrieve Pyodide lockfile, attempts to retrieve packages from the Pyodide CDN may fail. Error: ${message}`
      );
    }
  }

  // Track installed packages to avoid duplicates
  const installedPackages = new Set<string>();
  // Track in-progress installations to avoid duplicate work
  const inProgress = new Map<string, Promise<void>>();

  // Install all dependencies in parallel
  await Promise.all(
    depsToInstall.map((dependencySpecifier) =>
      installPythonPackage(
        dependencySpecifier,
        result,
        fileSystem,
        installedPackages,
        inProgress,
        PYPI_SIMPLE_API
      )
    )
  );
  return result;
}

/**
 * Parse a Python version specifier string (PEP 508).
 * Currently only extracts the package name.
 */
function parsePythonDependencySpecifier(spec: string): { name: string } {
  // Drop the PEP 508 environment marker (everything after `;`)
  let head = spec.split(";", 1)[0] ?? "";

  // The package name is the leading run of characters allowed in a PEP 508
  // identifier: letters, digits, `.`, `-`, `_`. Stop at the first character
  // that isn't one of those (whitespace, `[`, `(`, `<`, `>`, `=`, `!`, `~`, etc.).
  const match = head.match(/^\s*([A-Za-z0-9][A-Za-z0-9._-]*)/);
  const name = match ? match[1]! : head.trim();

  return { name: name };
}
/**
 * Install a single Python package from the Pyodide index.
 * Uses PyPI as a fallback.
 */
export async function installPythonPackage(
  dependencySpecifier: string, // the full dependency specifier
  result: InstallResult,
  fileSystem: FileSystem,
  installedPackages: Set<string>,
  inProgress: Map<string, Promise<void>>,
  backupRegistry: string
): Promise<void> {
  const name = parsePythonDependencySpecifier(dependencySpecifier)["name"];
  // Skip if already installed in this run
  if (installedPackages.has(name)) {
    return;
  }

  if (!shouldInstallDependency(dependencySpecifier)) {
    return;
  }

  // We explicitly want to deal in names only here, not full dep strings. Only allowing one version of a package per Python environment is defined behavior
  // This was previously in installPromise, but was moved up upon observing that races could still lead to redundant fetches
  installedPackages.add(name);

  // TODO: In the JS impl., a check is done here for whether the package already exists in the filesystem
  // Assess in the future whether this is sensible to repeat

  // If installation is already in progress, wait for it
  const existing = inProgress.get(name);
  if (existing) {
    return existing;
  }

  const installPromise = (async () => {
    try {
      let response: Response = {} as Response;
      let wheel: PyPASimpleFile = {} as PyPASimpleFile;
      let version: string = "";

      // Try the Pyodide index first, then fall back to PyPI if that fails
      let registryResult = await retrieveFromPyodide(name);
      if (registryResult) {
        [response, wheel, version] = registryResult;
      } else {
        registryResult = await retrieveFromPyPI(name, backupRegistry);
        if (registryResult) {
          [response, wheel, version] = registryResult;
        } else {
          throw new Error(
            `Failed to download ${name}@${version}: ${response.status} ${response.statusText} (${wheel.url})`
          );
        }
      }
      const buffer = await response.arrayBuffer();

      const wheelContents = extractWheel(new Uint8Array(buffer));
      const dependencies = getDependenciesFromWheel(wheelContents);
      const packageFilesWheel = stripWheelToPackage(wheelContents);

      result.installed.push(`${name}@${version}`);

      // Add files to python_modules
      for (const [filePath, content] of Object.entries(packageFilesWheel)) {
        fileSystem.write(`python_modules/${filePath}`, content);
      }

      await Promise.all(
        dependencies.map((dep) =>
          installPythonPackage(
            dep,
            result,
            fileSystem,
            installedPackages,
            inProgress,
            PYPI_SIMPLE_API
          )
        )
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      result.warnings.push(`Failed to install ${name}: ${message}`);
    }
  })();

  inProgress.set(name, installPromise);

  try {
    await installPromise;
  } finally {
    inProgress.delete(name);
  }
}

// TODO: Genericize this to use the HTML version of this API and use it for both the Pyodide index and PyPI
async function retrieveFromPyPI(
  name: string,
  registry: string
): Promise<[Response, PyPASimpleFile, string] | null> {
  const metadata = await fetchPythonPackageMetadata(name, registry);
  const version = metadata.version;
  const wheel = metadata.wheel;

  const response = await fetchWithTimeout(
    wheel.url,
    {},
    DEFAULT_TIMEOUT_MS * 2
  );

  if (!response.ok) {
    return null;
  }

  return [response, wheel, version];
}

// TODO: Alter the flow to use the PyPA simple api (index.pyodide.org)
async function retrieveFromPyodide(
  name: string
): Promise<[Response, PyPASimpleFile, string] | null> {
  const pyodideWheel = getPyodideWheel(name);
  if (!pyodideWheel) {
    return null;
  }

  const response = await fetchWithTimeout(
    pyodideWheel.url,
    {},
    DEFAULT_TIMEOUT_MS * 2
  );
  if (!response.ok) {
    return null;
  }

  const version = pyodideWheel.package.version;
  const wheel = pyodideWheel.file;
  return [response, wheel, version];
}

// Determine whether a dependency (as listed in a wheel's METADATA) is appropriate to install
function shouldInstallDependency(dependencySpecifier: string): boolean {
  // TODO: This should actually check whether extras are called for, as well as other environment and compatibility attributes
  // For the time being, it excludes any dependency that is behind an 'extra'
  const semicolonPos = dependencySpecifier.indexOf(";");
  if (
    semicolonPos > -1 &&
    (dependencySpecifier.substring(semicolonPos).includes("extra ==") ||
      dependencySpecifier.substring(semicolonPos).includes("extra=="))
  ) {
    return false;
  }

  return true;
}

/**
 * Strip a Python wheel down to just the package contents.
 *
 * TODO: Re-review this function once we've cleared issues with file extension limits
 * in workerd; this function excludes certain metadata files in *.dist-info/ for now but it shouldn't remain this way
 */
function stripWheelToPackage(
  files: Record<string, FileEntry>
): Record<string, FileEntry> {
  const result: Record<string, FileEntry> = {};
  for (const [path, content] of Object.entries(files)) {
    // Skip wheel metadata and data directories
    if (path.includes(".dist-info/") || path.includes(".data/")) {
      continue;
    }
    // We'll expect that any remaining directories in the wheel are importable packages
    result[path] = content;
  }
  return result;
}

/**
 * Fetch the Pyodide lockfile for a given Pyodide version.
 *
 * The lockfile lists all pre-built packages available in the Pyodide
 * distribution, including their wheel URLs, hashes, and dependencies.
 */
async function fetchPyodideLockfile(
  version: string
): Promise<PyodideLockfile | null> {
  const url = `https://cdn.jsdelivr.net/pyodide/${version}/full/pyodide-lock.json`;
  try {
    const response = await fetchWithTimeout(url);
    if (!response.ok) {
      return null;
    }
    return (await response.json()) as PyodideLockfile;
  } catch {
    return null;
  }
}

/**
 * Normalize a Python package name per PEP 503.
 *
 * Lowercases the name and collapses runs of `-`, `_`, and `.` into a single `-`.
 */
function normalizePythonName(name: string): string {
  return name.toLowerCase().replace(/[-_.]+/g, "-");
}

/**
 * Look up a package in the loaded Pyodide lockfile and return the URL and a
 * Simple-API-shaped file entry for its wheel.
 *
 * Returns `null` if the lockfile is not loaded or the package is not present.
 */
function getPyodideWheel(name: string): PyodideWheelInfo | null {
  if (!pyodideLockfile) return null;

  const normalizedName = normalizePythonName(name);
  const pkg = pyodideLockfile.packages[normalizedName];
  if (!pkg) return null;

  const baseUrl = `https://cdn.jsdelivr.net/pyodide/${PYODIDE_VERSION}/full`;
  const url = pkg.file_name.startsWith("http")
    ? pkg.file_name
    : `${baseUrl}/${pkg.file_name}`;

  return {
    package: pkg,
    url,
    file: {
      filename: pkg.file_name,
      url,
      hashes: { sha256: pkg.sha256 }
    }
  };
}

/*
 * Fetch metadata about the 'name' package from 'registry' registry.
 * Expects the registry to support the PyPA Simple API (JSON ver)
 */
async function fetchPythonPackageMetadata(
  name: string,
  registry: string
): Promise<{ version: string; wheel: PyPASimpleFile }> {
  const normalizedName = normalizePythonName(name);

  // Fetch package metadata from PyPI Simple API
  const metadataResponse = await fetchWithTimeout(
    `${registry}/${normalizedName}/`,
    {
      headers: {
        Accept: "application/vnd.pypi.simple.v1+json"
      }
    }
  );

  if (!metadataResponse.ok) {
    const hint =
      metadataResponse.status === 404
        ? " (package not found — check the name in pyproject.toml)"
        : "";
    throw new Error(
      `Registry ${registry} returned ${metadataResponse.status} ${metadataResponse.statusText} for "${name}"${hint}`
    );
  }
  const metadata = (await metadataResponse.json()) as PyPASimpleMetadata;

  const wheel = selectLatestCompatibleWheel(metadata.files);
  if (!wheel) {
    throw new Error(
      `No compatible wheel found for ${name} on registry ${registry}`
    );
  }

  const version = parseVersionFromWheelName(wheel.filename);
  if (!version) {
    throw new Error(
      `Could not parse version from wheel filename: ${wheel.filename}`
    );
  }

  return { version, wheel };
}

/**
 * Select a compatible wheel from PyPI Simple API files list.
 * Prefers py3-none-any or py2.py3-none-any wheels for maximum compatibility.
 * Selects the latest version from compatible wheels.
 * TODO: implement proper platform/python version matching
 */
function selectLatestCompatibleWheel(
  files: PyPASimpleFile[]
): PyPASimpleFile | null {
  const wheels = files.filter((f) => f.filename.endsWith(".whl"));
  if (wheels.length === 0) return null;

  // Filter to universal wheels (py3-none-any or py2.py3-none-any)
  const universal = wheels.filter(
    (w) =>
      w.filename.endsWith("-py3-none-any.whl") ||
      w.filename.endsWith("-py2.py3-none-any.whl")
  );

  const candidates = universal.length > 0 ? universal : wheels;

  // Select the wheel with the highest version
  let latest: PyPASimpleFile | null = null;
  let latestVersion: string | undefined;

  for (const wheel of candidates) {
    const version = parseVersionFromWheelName(wheel.filename);
    if (!version) continue;

    if (
      !latest ||
      !latestVersion ||
      comparePythonVersions(version, latestVersion) > 0
    ) {
      latest = wheel;
      latestVersion = version;
    }
  }

  return latest;
}

/**
 * Compare two PEP 440 version strings.
 * Returns >0 if a > b, <0 if a < b, 0 if equal.
 *
 * Python versions (PEP 440) are not semver-compatible (e.g. "3.6.2.1" has four
 * release segments), so semver cannot be used here. This is a minimal
 * comparison: it compares the dotted numeric release segments, and treats
 * pre-release/dev versions (a/b/rc/alpha/beta/dev/pre) as lower than the same
 * release so a stable release is preferred.
 * TODO: full PEP 440 ordering (post-releases, local versions, epochs) if needed.
 */
export function comparePythonVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const releaseMatch = v.match(/^[0-9]+(?:\.[0-9]+)*/);
    const release = (releaseMatch?.[0] ?? "0").split(".").map(Number);
    const rest = v.slice(releaseMatch?.[0].length ?? 0);
    const isPre = /^[.\-_]?(a|b|c|rc|alpha|beta|dev|pre)/i.test(rest);
    return { release, isPre };
  };

  const av = parse(a);
  const bv = parse(b);

  const len = Math.max(av.release.length, bv.release.length);
  for (let i = 0; i < len; i++) {
    const diff = (av.release[i] ?? 0) - (bv.release[i] ?? 0);
    if (diff !== 0) return diff;
  }

  // Same release: a stable version outranks a pre-release/dev version
  if (av.isPre !== bv.isPre) return av.isPre ? -1 : 1;
  return 0;
}

/**
 * Parse version from a wheel filename.
 * Wheel format: {distribution}-{version}(-{build})?-{python}-{abi}-{platform}.whl
 *
 * With no build tag (5 parts): distribution-version-python-abi-platform.whl
 * With build tag (6+ parts): distribution-version-build-python-abi-platform.whl
 */
function parseVersionFromWheelName(filename: string): string | undefined {
  const parts = filename.replace(/\.whl$/, "").split("-");
  if (parts.length < 5) return undefined;

  // The last three parts are always: python_tag, abi_tag, platform_tag
  // For 5 parts: distribution, version, py, abi, platform -> version is parts[1]
  // For 6+ parts: distribution, version, build?, py, abi, platform -> version is parts[1]
  return parts[1];
}

/**
 * Extract Requires-Dist entries from a wheel's *.dist-info/METADATA file.
 * Accepts the file record returned by `extractWheel`.
 * Returns an empty array if METADATA is missing or contains no dependencies.
 */
function getDependenciesFromWheel(files: Record<string, FileEntry>): string[] {
  const metadataPath = Object.keys(files).find((path) =>
    path.endsWith(".dist-info/METADATA")
  );
  if (!metadataPath) return [];
  const metadata = files[metadataPath];
  if (!metadata) return [];
  if (typeof metadata !== "string") return [];
  return parseRequiresDist(metadata);
}

/**
 * Parse Requires-Dist headers from Python package METADATA file (RFC 822 format).
 */
function parseRequiresDist(metadata: string): string[] {
  const requires: string[] = [];
  const lines = metadata.split(/\r?\n/);

  for (const line of lines) {
    // Process previous header if it was Requires-Dist
    if (line !== undefined && line.startsWith("Requires-Dist:")) {
      requires.push(line.slice("Requires-Dist:".length).trim());
    }
  }

  return requires;
}

/**
 * Extract files from a ZIP archive (Python wheel).
 */
function extractWheel(data: Uint8Array): Record<string, FileEntry> {
  const unzipped = unzipSync(data);
  const files: Record<string, FileEntry> = {};
  const textDecoder = new TextDecoder();

  for (const [path, content] of Object.entries(unzipped)) {
    // Keep the wheel's core metadata file so callers can read Requires-Dist from it.
    // This file has no extension, so it would otherwise be rejected by isTextFile.
    // TODO: Remove this after we clear the other todo constraining down to just text files
    if (path.endsWith(".dist-info/METADATA")) {
      files[path] = textDecoder.decode(content);
      continue;
    }

    if (
      // TODO: This can be removed once it's confirmed that workerd doesn't block these (and other) file extensions
      path.endsWith(".md") ||
      path.endsWith(".css") ||
      path.endsWith(".js") ||
      path.endsWith(".txt") ||
      path.endsWith("LICENSE") ||
      path.endsWith(".rst")
    ) {
      continue;
    }

    if (isTextFile(path)) {
      files[path] = textDecoder.decode(content);
    } else {
      files[path] = { data: new Uint8Array(content) };
    }
  }

  return files;
}
