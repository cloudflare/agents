/**
 * NPM package installer for virtual file systems.
 *
 * This module fetches packages from the npm registry and populates
 * a virtual node_modules directory structure.
 */

import * as semver from "semver";
import { unzipSync } from "fflate";
import type { FileSystem } from "./file-system";
import { parse as parseToml } from "smol-toml";

const NPM_REGISTRY = "https://registry.npmjs.org";
const PYPI_SIMPLE_API = "https://pypi.org/simple";
const PYODIDE_VERSION = "v0.28.2"; // Used for retrieving a pyodide lockfile, which is done per Pyodide version
const DEFAULT_TIMEOUT_MS = 30000; // 30 seconds

/**
 * Fetch with a timeout.
 * Throws an error if the request takes longer than the specified timeout.
 */
async function fetchWithTimeout(
  url: string,
  options: RequestInit = {},
  timeoutMs = DEFAULT_TIMEOUT_MS
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(
        `Request to ${url} timed out after ${timeoutMs}ms (npm registry slow or unreachable from this Worker)`
      );
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

interface PackageJson {
  name: string;
  version: string;
  main?: string;
  module?: string;
  exports?: unknown;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  dist?: {
    tarball: string;
    integrity?: string;
  };
}

// Deliberately keeping this minimal
interface PyprojectToml {
  project?: {
    name: string;
    version: string;
    dependencies?: string[];
  };
}

interface NpmPackageMetadata {
  name: string;
  "dist-tags": Record<string, string>;
  versions: Record<string, PackageJson>;
}

interface PypiSimpleFile {
  filename: string;
  url: string;
  hashes?: Record<string, string>;
  "requires-python"?: string;
  "core-metadata"?: boolean | { hash?: string; url?: string };
  yanked?: boolean | string;
}

interface PypiSimpleMetadata {
  name: string;
  files: PypiSimpleFile[];
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

// Making this global so it will only need to be fetched once per invocation
// TODO: Consider distributing this with Pyodide itself since it's not likely to change very much between runs
let pyodideLockfile: PyodideLockfile | null = null;

interface InstallOptions {
  /**
   * Include devDependencies (default: false)
   */
  dev?: boolean;

  /**
   * Registry URL (default: https://registry.npmjs.org)
   */
  registry?: string;

  /**
   * If installing Python packages, set whether to prefer the Pyodide index (default: true)
   */
  preferPyodideIndex?: boolean;
}

export interface InstallResult {
  /**
   * Packages that were freshly installed in this call.
   * Packages already present in the filesystem are skipped and not listed here.
   */
  installed: string[];

  /**
   * Warnings encountered during installation
   */
  warnings: string[];
}

/**
 * Install npm dependencies into a virtual file system.
 *
 * Reads the package.json from the files, resolves all dependencies,
 * and populates node_modules with the package contents.
 *
 * @param fileSystem - Virtual file system containing package.json
 * @param options - Installation options
 * @returns Metadata about the installation
 */
export async function installDependencies(
  fileSystem: FileSystem,
  options: InstallOptions = {}
): Promise<InstallResult> {
  const {
    dev = false,
    registry = NPM_REGISTRY,
    preferPyodideIndex = true
  } = options;

  const result: InstallResult = {
    installed: [],
    warnings: []
  };

  // Read package.json
  const packageJsonContent = fileSystem.read("package.json");
  const pyprojectTomlContent = fileSystem.read("pyproject.toml");

  if (packageJsonContent && pyprojectTomlContent) {
    result.warnings.push("Cannot have package.json and pyproject.toml");
    return result;
  }

  if (packageJsonContent) {
    let packageJson: PackageJson;
    try {
      packageJson = JSON.parse(packageJsonContent) as PackageJson;
    } catch {
      result.warnings.push("Failed to parse package.json");
      return result;
    }

    // Collect dependencies to install
    const depsToInstall: Record<string, string> = {
      ...packageJson.dependencies,
      ...(dev ? packageJson.devDependencies : {})
    };

    if (Object.keys(depsToInstall).length === 0) {
      return result; // No dependencies to install
    }

    // Track installed packages to avoid duplicates
    const installedPackages = new Map<string, string>(); // name -> version
    // Track in-progress installations to avoid duplicate work
    const inProgress = new Map<string, Promise<void>>();

    // Install all dependencies in parallel
    await Promise.all(
      Object.entries(depsToInstall).map(([name, versionRange]) =>
        installPackage(
          name,
          versionRange,
          result,
          fileSystem,
          installedPackages,
          inProgress,
          registry
        )
      )
    );
  } else if (pyprojectTomlContent) {
    return await installDependenciesPython(
      fileSystem,
      pyprojectTomlContent,
      preferPyodideIndex
    );
  }
  return result;
}

/**
 * Install Python dependencies declared in a pyproject.toml file.
 */
async function installDependenciesPython(
  fileSystem: FileSystem,
  pyprojectTomlContent: string,
  preferPyodideIndex: boolean
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

  // Collect dependencies to install
  const depsToInstall: Record<string, string> = {};
  depsToInstall["workers-runtime-sdk"] = "*"; // TODO: Should this always take the latest?
  for (const dep of pyprojectToml.project?.dependencies ?? []) {
    const name = dep.trim();
    if (!name) continue;

    depsToInstall[name] = "*"; // in the future this should be a version specifier, if one was set
  }

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
  const installedPackages = new Map<string, string>(); // name -> version
  // Track in-progress installations to avoid duplicate work
  const inProgress = new Map<string, Promise<void>>();

  // Install all dependencies in parallel
  await Promise.all(
    Object.entries(depsToInstall).map(([depName]) =>
      installPythonPackage(
        depName,
        result,
        fileSystem,
        installedPackages,
        inProgress,
        PYPI_SIMPLE_API,
        preferPyodideIndex
      )
    )
  );
  return result;
}

/**
 * Install a single package and its dependencies recursively.
 */
async function installPackage(
  name: string,
  versionRange: string,
  result: InstallResult,
  fileSystem: FileSystem,
  installedPackages: Map<string, string>,
  inProgress: Map<string, Promise<void>>,
  registry: string
): Promise<void> {
  // Skip if already installed in this run
  if (installedPackages.has(name)) {
    return;
  }

  // Skip if the package already exists in the filesystem. This allows
  // installDependencies to be called on a pre-warmed FileSystem (e.g. after a
  // prior standalone installDependencies call, or a DO filesystem loaded from
  // KV) without triggering redundant network fetches for packages that are
  // already present. Transitive deps are assumed to also be present when the
  // top-level package.json is found.
  if (fileSystem.read(`node_modules/${name}/package.json`) !== null) {
    installedPackages.set(name, "existing");
    return;
  }

  // If installation is already in progress, wait for it
  const existing = inProgress.get(name);
  if (existing) {
    return existing;
  }

  // Create the installation promise
  const installPromise = (async () => {
    try {
      // Fetch package metadata from registry
      const metadata = await fetchPackageMetadata(name, registry);

      // Resolve version from range
      const version = resolveVersion(versionRange, metadata);
      if (!version) {
        result.warnings.push(
          `Could not resolve version for ${name}@${versionRange}`
        );
        return;
      }

      // Get the specific version metadata
      const versionMetadata = metadata.versions[version];
      if (!versionMetadata) {
        result.warnings.push(`Version ${version} not found for ${name}`);
        return;
      }

      // Mark as installed (before fetching to prevent cycles)
      installedPackages.set(name, version);
      result.installed.push(`${name}@${version}`);

      // Fetch and extract the package tarball
      const packageFiles = await fetchPackageFiles(name, versionMetadata);

      // Add files to node_modules
      for (const [filePath, content] of Object.entries(packageFiles)) {
        fileSystem.write(`node_modules/${name}/${filePath}`, content);
      }

      // Install dependencies in parallel
      const deps = versionMetadata.dependencies ?? {};
      await Promise.all(
        Object.entries(deps).map(([depName, depVersion]) =>
          installPackage(
            depName,
            depVersion,
            result,
            fileSystem,
            installedPackages,
            inProgress,
            registry
          )
        )
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      result.warnings.push(`Failed to install ${name}: ${message}`);
    }
  })();

  // Track in progress
  inProgress.set(name, installPromise);

  try {
    await installPromise;
  } finally {
    inProgress.delete(name);
  }
}

/**
 * Install a single Python package from PyPI.
 *
 * This is a minimal implementation: it downloads the latest version of the
 * package as a source distribution and adds it to python_modules/. It does not
 * resolve version ranges or install transitive dependencies.
 */
async function installPythonPackage(
  name: string,
  // _versionRange: string, // remove fully if package resolver impl. ends up not going through this path
  result: InstallResult,
  fileSystem: FileSystem,
  installedPackages: Map<string, string>,
  inProgress: Map<string, Promise<void>>,
  registry: string,
  preferPyodideIndex: boolean
): Promise<void> {
  // Skip if already installed in this run
  if (installedPackages.has(name)) {
    return;
  }

  // TODO: In the JS impl., a check is done here for whether the package already exists in the filesystem
  // Assess in the future whether this is sensible to repeat

  // If installation is already in progress, wait for it
  const existing = inProgress.get(name);
  if (existing) {
    return existing;
  }

  const installPromise = (async () => {
    try {
      // Setting default values since some of the errors below access these and they may not all be set in all cases
      let response: Response = {} as Response;
      let wheel: PypiSimpleFile = {} as PypiSimpleFile;
      let version: string = "";

      // Putting the logic for retrieving a wheel from PyPI and the Pyodide index into their own functions here
      // This is so either one can be used as a fallback for the other in a (relatively) tidy way
      const retrieveFromPyPI = async (
        name: string,
        registry: string
      ): Promise<[Response, PypiSimpleFile, string, string[]] | null> => {
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
      };

      const retrieveFromPyodide = async (
        name: string
      ): Promise<[Response, PypiSimpleFile, string, string[]] | null> => {
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
      };

      // Try either PyPI or the Pyodide index, then fall back to the other one if that one fails
      if (preferPyodideIndex) {
        let registryResult = await retrieveFromPyodide(name);
        if (registryResult) {
          [response, wheel, version] = registryResult;
        } else {
          registryResult = await retrieveFromPyPI(name, registry);
          if (registryResult) {
            [response, wheel, version] = registryResult;
          } else {
            throw new Error(
              `Failed to download ${name}@${version}: ${response.status} ${response.statusText} (${wheel.url})`
            );
          }
        }
      } else {
        let registryResult = await retrieveFromPyPI(name, registry);
        if (registryResult) {
          [response, wheel, version] = registryResult;
        } else {
          registryResult = await retrieveFromPyodide(name);
          if (registryResult) {
            [response, wheel, version] = registryResult;
          } else {
            throw new Error(
              `Failed to download ${name}@${version}: ${response.status} ${response.statusText} (${wheel.url})`
            );
          }
        }
      }
      const buffer = await response.arrayBuffer();

      const wheelContents = extractWheel(new Uint8Array(buffer), result);
      const dependencies = getDependenciesFromWheel(wheelContents);
      const packageFilesWheel = stripWheelToPackage(wheelContents);

      // Mark as installed before writing to prevent cycles
      installedPackages.set(name, version);
      result.installed.push(`${name}@${version}`);

      // Add files to python_modules
      for (const [filePath, content] of Object.entries(packageFilesWheel)) {
        fileSystem.write(`python_modules/${filePath}`, content);
      }

      await Promise.all(
        dependencies.map((dep) =>
          installPythonPackage(
            parsePythonVersionString(dep)["name"], // This will change (ie look nicer) after we've completely fleshed out what this should return
            result,
            fileSystem,
            installedPackages,
            inProgress,
            PYPI_SIMPLE_API,
            preferPyodideIndex
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

/**
 * Strip a Python wheel down to just the package contents.
 *
 * Wheels contain the importable package alongside `.dist-info` metadata and
 * `.data` directories. This removes those supporting directories and flattens
 * the package directory so its files are at the root of the returned record.
 */
function stripWheelToPackage(
  files: Record<string, string>
): Record<string, string> {
  const result: Record<string, string> = {};
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
 * Fetch package metadata from npm registry.
 */
async function fetchPackageMetadata(
  name: string,
  registry: string
): Promise<NpmPackageMetadata> {
  // Handle scoped packages
  const encodedName = name.startsWith("@")
    ? `@${encodeURIComponent(name.slice(1))}`
    : name;
  const url = `${registry}/${encodedName}`;

  const response = await fetchWithTimeout(url, {
    headers: {
      // Use abbreviated metadata to avoid fetching megabytes of version data
      Accept:
        "application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8"
    }
  });

  if (!response.ok) {
    // 404 on the registry usually means the package name is wrong (typo,
    // wrong scope) or the registry doesn't host it — call that out.
    const hint =
      response.status === 404
        ? " (package not found — check the name in package.json or set the `registry` option if it lives on a private registry)"
        : "";
    throw new Error(
      `Registry returned ${response.status} ${response.statusText} for "${name}" at ${url}${hint}`
    );
  }

  return (await response.json()) as NpmPackageMetadata;
}

async function fetchPythonPackageMetadata(name: string, registry: string) {
  // Fetch package metadata from PyPI JSON API
  // TODO: Redo this to use the PyPA simple repository API
  const metadataResponse = await fetchWithTimeout(`${registry}/${name}/json`);
  if (!metadataResponse.ok) {
    const hint =
      metadataResponse.status === 404
        ? " (package not found — check the name in pyproject.toml)"
        : "";
    throw new Error(
      `PyPI returned ${metadataResponse.status} ${metadataResponse.statusText} for "${name}"${hint}`
    );
  }
  const metadata = (await metadataResponse.json()) as {
    info: { version: string };

    urls: Array<{
      filename: string;
      url: string;
      packagetype: string;
    }>;
  };
  return metadata;
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
function getPyodideWheel(name: string): {
  package: PyodideLockfilePackage;
  url: string;
  file: PypiSimpleFile;
} | null {
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

async function fetchPythonPackageMetadata(
  name: string,
  registry: string
): Promise<{ version: string; wheel: PypiSimpleFile }> {
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
      `PyPI returned ${metadataResponse.status} ${metadataResponse.statusText} for "${name}"${hint}`
    );
  }
  const metadata = (await metadataResponse.json()) as PypiSimpleMetadata;

  const wheel = selectWheel(metadata.files);
  if (!wheel) {
    throw new Error(`No compatible wheel found for ${name} on PyPI`);
  }

  const version = parseWheelVersion(wheel.filename);
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
function selectWheel(files: PypiSimpleFile[]): PypiSimpleFile | undefined {
  const wheels = files.filter((f) => f.filename.endsWith(".whl"));
  if (wheels.length === 0) return undefined;

  // Filter to universal wheels (py3-none-any or py2.py3-none-any)
  const universal = wheels.filter(
    (w) =>
      w.filename.includes("-py3-none-any.whl") ||
      w.filename.includes("-py2.py3-none-any.whl")
  );

  const candidates = universal.length > 0 ? universal : wheels;

  // Select the wheel with the highest version
  let latest: PypiSimpleFile | undefined;
  let latestVersion: string | undefined;

  for (const wheel of candidates) {
    const version = parseWheelVersion(wheel.filename);
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
function comparePythonVersions(a: string, b: string): number {
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
 *
 * TODO: handle edge cases with distribution names containing hyphens
 */
function parseWheelVersion(filename: string): string | undefined {
  const parts = filename.replace(/\.whl$/, "").split("-");
  if (parts.length < 5) return undefined;

  // The last three parts are always: python_tag, abi_tag, platform_tag
  // For 5 parts: distribution, version, py, abi, platform -> version is parts[1]
  // For 6+ parts: distribution, version, build?, py, abi, platform -> version is parts[1]
  return parts[1];
}

/**
 * Get the core metadata URL from a PyPI Simple API file entry.
 * Returns undefined if core metadata is not available.
 *
 * Per PEP 714: if core-metadata is true or an object (with hash),
 * metadata is available at {file_url}.metadata unless a separate URL is provided.
 */
function getCoreMetadataUrl(file: PypiSimpleFile): string | undefined {
  const cm = file["core-metadata"];
  if (!cm) return undefined;

  // If it's an object with an explicit URL, use that
  if (typeof cm === "object" && cm.url) return cm.url;

  // Otherwise (boolean true or object with just hash), use .metadata suffix
  if (cm === true || typeof cm === "object") return `${file.url}.metadata`;

  return undefined;
}

/**
 * Fetch and parse Requires-Dist from a Python package's core metadata.
 * Returns empty array if metadata is unavailable or parsing fails.
 */
async function fetchPythonRequiresDist(url: string): Promise<string[]> {
  try {
    const response = await fetchWithTimeout(url);
    if (!response.ok) return [];
    const contentType = response.headers.get("content-type") ?? "";
    // PyPI tends to send this as `binary/octet-stream` even though it's actually text, this avoids an unhelpful warning
    const text = contentType.startsWith("text/")
      ? await response.text()
      : new TextDecoder().decode(await response.arrayBuffer());
    return parseRequiresDist(text);
  } catch {
    return [];
  }
}

/**
 * Extract Requires-Dist entries from a wheel's *.dist-info/METADATA file.
 * Accepts the file record returned by `extractWheel`.
 * Returns an empty array if METADATA is missing or contains no dependencies.
 */
function getDependenciesFromWheel(files: Record<string, string>): string[] {
  const metadataPath = Object.keys(files).find((path) =>
    path.endsWith(".dist-info/METADATA")
  );
  if (!metadataPath) return [];
  const metadata = files[metadataPath];
  if (!metadata) return [];
  return parseRequiresDist(metadata);
}

/**
 * Parse Requires-Dist headers from Python package METADATA file (RFC 822 format).
 * Handles continuation lines (starting with whitespace).
 */
function parseRequiresDist(metadata: string): string[] {
  const requires: string[] = [];
  const lines = metadata.split(/\r?\n/);
  let current: string | undefined;

  for (const raw of lines) {
    // Continuation line (starts with whitespace)
    if (raw.startsWith(" ") || raw.startsWith("\t")) {
      if (current !== undefined) {
        current += " " + raw.trim();
      }
      continue;
    }

    // Process previous header if it was Requires-Dist
    if (current !== undefined && current.startsWith("Requires-Dist:")) {
      requires.push(current.slice("Requires-Dist:".length).trim());
    }

    current = raw;
  }

  // Process last header
  if (current !== undefined && current.startsWith("Requires-Dist:")) {
    requires.push(current.slice("Requires-Dist:".length).trim());
  }

  return requires;
}

/**
 * Resolve a semver range to a specific version.
 */
function resolveVersion(
  range: string,
  metadata: NpmPackageMetadata
): string | undefined {
  // Handle special cases
  if (range === "latest" || range === "*") {
    return metadata["dist-tags"]["latest"];
  }

  // Handle exact versions
  if (metadata.versions[range]) {
    return range;
  }

  // Handle dist-tags (e.g., "next", "beta")
  if (metadata["dist-tags"][range]) {
    return metadata["dist-tags"][range];
  }

  // Use semver.maxSatisfying to find the best matching version
  const versions = Object.keys(metadata.versions);
  const match = semver.maxSatisfying(versions, range);

  return match ?? undefined;
}

/**
 * Fetch and extract package files from npm tarball.
 */
export async function fetchPackageFiles(
  name: string,
  metadata: PackageJson
): Promise<Record<string, string>> {
  const tarballUrl = metadata.dist?.tarball;
  if (!tarballUrl) {
    throw new Error(
      `Registry metadata for ${name}@${metadata.version} is missing \`dist.tarball\` — the registry response is likely malformed or the version was unpublished.`
    );
  }

  // Fetch the tarball (use longer timeout for potentially large packages)
  const response = await fetchWithTimeout(
    tarballUrl,
    {},
    DEFAULT_TIMEOUT_MS * 2
  );
  if (!response.ok) {
    throw new Error(
      `Failed to fetch tarball for ${name}@${metadata.version}: ${response.status} ${response.statusText} (${tarballUrl})`
    );
  }

  // Get the tarball as array buffer
  const buffer = await response.arrayBuffer();

  // Extract the tarball (npm tarballs are gzipped tar files)
  return extractTarball(new Uint8Array(buffer));
}

/**
 * Extract files from a ZIP archive (Python wheel).
 *
 * Python wheels are distributed as .whl files (ZIP archives).
 */
function extractWheel(
  data: Uint8Array,
  result: InstallResult
): Record<string, string> {
  const unzipped = unzipSync(data);
  const files: Record<string, string> = {};
  const textDecoder = new TextDecoder();

  for (const [path, content] of Object.entries(unzipped)) {
    // Keep the wheel's core metadata file so callers can read Requires-Dist from it.
    // This file has no extension, so it would otherwise be rejected by isTextFile.
    // TODO: Remove this after we clear the other todo constraining down to just text files
    if (path.endsWith(".dist-info/METADATA")) {
      files[path] = textDecoder.decode(content);
      continue;
    }

    // TODO: Remove this check once it's confirmed that compiled wasm binaries are working
    // (blocking this for now so any such packages will fail gracefully in the interim)
    if (!isTextFile(path)) {
      result.warnings.push(
        `Could not install file ${path}, extension must match an approved text format type. This may corrupt this dependency.`
      );
      continue;
    }
    files[path] = textDecoder.decode(content);
  }

  return files;
}

/**
 * Extract files from a gzipped tarball.
 *
 * npm packages are distributed as .tgz files (gzipped tar).
 * The contents are in a "package/" directory.
 */
async function extractTarball(
  data: Uint8Array
): Promise<Record<string, string>> {
  // Decompress gzip
  const decompressed = await decompress(data);

  // Parse tar
  return parseTar(decompressed);
}

/**
 * Decompress gzip data using DecompressionStream.
 */
async function decompress(data: Uint8Array): Promise<Uint8Array> {
  // Use DecompressionStream (available in Workers and modern browsers)
  const ds = new DecompressionStream("gzip");
  const writer = ds.writable.getWriter();
  const reader = ds.readable.getReader();

  // Write compressed data
  writer.write(data as Uint8Array<ArrayBuffer>).catch(() => {});
  writer.close().catch(() => {});

  // Read decompressed data
  const chunks: Uint8Array[] = [];
  let totalLength = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    totalLength += value.length;
  }

  // Concatenate chunks
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }

  return result;
}

/**
 * Parse a tar archive and extract text files.
 *
 * TAR format:
 * - 512-byte header blocks
 * - File content (padded to 512 bytes)
 * - Two empty blocks at the end
 */
function parseTar(data: Uint8Array): Record<string, string> {
  const files: Record<string, string> = {};
  const textDecoder = new TextDecoder();
  let offset = 0;

  while (offset < data.length - 512) {
    // Read header
    const header = data.slice(offset, offset + 512);

    // Check for empty block (end of archive)
    if (header.every((b) => b === 0)) {
      break;
    }

    // Parse header fields
    const name = readString(header, 0, 100);
    const sizeStr = readString(header, 124, 12);
    const typeFlag = header[156];

    // Parse size (octal)
    const size = parseInt(sizeStr.trim(), 8) || 0;

    // Move past header
    offset += 512;

    // Only process regular files (type '0' or '\0')
    if ((typeFlag === 48 || typeFlag === 0) && size > 0) {
      // Read file content
      const content = data.slice(offset, offset + size);

      // Remove "package/" prefix from npm tarballs
      let filePath = name;
      if (filePath.startsWith("package/")) {
        filePath = filePath.slice(8);
      }

      // Only include text files (skip binary files)
      if (isTextFile(filePath)) {
        try {
          files[filePath] = textDecoder.decode(content);
        } catch {
          // Skip files that can't be decoded as text
        }
      }
    }

    // Move to next block (content is padded to 512 bytes)
    offset += Math.ceil(size / 512) * 512;
  }

  return files;
}

/**
 * Read a null-terminated string from a buffer.
 */
function readString(
  buffer: Uint8Array,
  offset: number,
  length: number
): string {
  const bytes = buffer.slice(offset, offset + length);
  const nullIndex = bytes.indexOf(0);
  const relevantBytes = nullIndex >= 0 ? bytes.slice(0, nullIndex) : bytes;
  return new TextDecoder().decode(relevantBytes);
}

/**
 * Check if a file path is likely a text file.
 */
function isTextFile(path: string): boolean {
  const textExtensions = [
    ".js",
    ".mjs",
    ".cjs",
    ".ts",
    ".mts",
    ".cts",
    ".tsx",
    ".jsx",
    ".json",
    ".md",
    ".txt",
    ".css",
    ".html",
    ".yml",
    ".yaml",
    ".toml",
    ".xml",
    ".svg",
    ".map",
    ".d.ts",
    ".d.mts",
    ".d.cts",
    ".py"
  ];

  // Check common config files without extensions
  const configFiles = [
    "LICENSE",
    "README",
    "CHANGELOG",
    "package.json",
    "tsconfig.json",
    ".npmignore",
    ".gitignore"
  ];

  const fileName = path.split("/").pop() ?? "";

  if (
    configFiles.some((f) => fileName.toUpperCase().startsWith(f.toUpperCase()))
  ) {
    return true;
  }

  return textExtensions.some((ext) => path.toLowerCase().endsWith(ext));
}

/**
 * Parse a Python version specifier string (PEP 508) and extract the package name.
 *
 * Accepts strings as they appear in `pyproject.toml` `[project].dependencies`
 * or in PyPI JSON API `info.requires_dist` responses. Examples:
 *   "requests"
 *   "requests>=2.0"
 *   "requests[security]>=2.0"
 *   "requests (>=2.0)"
 *   "requests; python_version < '3.8'"
 *   "requests[security] >= 2.0 ; python_version < '3.8'"
 *
 * Returns a tuple of `[package_name, null, null]`. The second and third slots
 * are placeholders reserved for future use (e.g. extras, version specifier).
 */
function parsePythonVersionString(spec: string): { name: string } {
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
 * Check if files contain a package.json or pyproject.toml with dependencies that need installing.
 */
export function hasDependencies(files: FileSystem): boolean {
  const pyprojectToml = files.read("pyproject.toml");
  const packageJson = files.read("package.json");
  if (!packageJson && !pyprojectToml) return false;

  if (packageJson) {
    try {
      const pkg = JSON.parse(packageJson);
      const deps = pkg.dependencies ?? {};
      return Object.keys(deps).length > 0;
    } catch {
      return false;
    }
  }

  if (pyprojectToml) {
    try {
      const pkg = parseToml(pyprojectToml) as PyprojectToml;
      const deps = pkg.project?.dependencies ?? [];
      return deps.length > 0;
    } catch {
      return false;
    }
  }
  return false;
}
