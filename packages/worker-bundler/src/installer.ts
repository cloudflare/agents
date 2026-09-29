/**
 * NPM package installer for virtual file systems.
 *
 * This module fetches packages from the npm registry and populates
 * a virtual node_modules directory structure.
 * It also branches into the Python logic in installer-python.ts
 * if dependencies are declared for a Python dynamic worker.
 */

import { isTextFile, fetchWithTimeout, DEFAULT_TIMEOUT_MS } from "./common.ts";
import type { InstallResult } from "./common.ts";
import { installDependenciesPython } from "./installer-python";
import type { PyprojectToml } from "./installer-python";
import * as semver from "semver";
import type { FileSystem } from "./file-system";
import { parse as parseToml } from "smol-toml";

const NPM_REGISTRY = "https://registry.npmjs.org";

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

interface NpmPackageMetadata {
  name: string;
  "dist-tags": Record<string, string>;
  versions: Record<string, PackageJson>;
}

interface InstallOptions {
  /**
   * Include devDependencies (default: false)
   */
  dev?: boolean;

  /**
   * Registry URL (default: https://registry.npmjs.org)
   */
  registry?: string;
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
  const { dev = false, registry = NPM_REGISTRY } = options;

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
    const installedPackages = new Set<string>();
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
    return await installDependenciesPython(fileSystem, pyprojectTomlContent);
  }
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
  installedPackages: Set<string>,
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
    installedPackages.add(name);
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
      installedPackages.add(name);
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
 * Extract files from a gzipped tarball.
 *
 * npm packages are distributed as .tgz files (gzipped tar).
 * Package contents are usually enclosed by one archive directory, which is
 * removed by `parseTar` so returned paths are relative to the package root.
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
  const textDecoder = new TextDecoder();
  const regularFilePaths: string[] = [];
  const textFiles = new Map<string, string>();
  let offset = 0;

  while (offset < data.length - 512) {
    // Read header
    const header = data.slice(offset, offset + 512);

    // Check for empty block (end of archive)
    if (header.every((b) => b === 0)) {
      break;
    }

    // Parse header fields
    const filePath = normalizeTarEntryPath(readTarEntryPath(header));
    const sizeStr = readString(header, 124, 12);
    const typeFlag = header[156];

    // Parse size (octal)
    const size = parseInt(sizeStr.trim(), 8) || 0;

    // Move past header
    offset += 512;

    // Only regular files describe the paths this text-only extractor returns.
    // Tar metadata entries such as PAX headers and GNU long-name records must
    // not affect package root detection.
    const isRegularFile = typeFlag === 48 || typeFlag === 0;
    if (isRegularFile && filePath !== "") {
      regularFilePaths.push(filePath);
    }

    if (isRegularFile && size > 0 && isTextFile(filePath)) {
      // Read file content
      const content = data.slice(offset, offset + size);

      try {
        textFiles.set(filePath, textDecoder.decode(content));
      } catch {
        // Skip files that can't be decoded as text
      }
    }

    // Move to next block (content is padded to 512 bytes)
    offset += Math.ceil(size / 512) * 512;
  }

  const archiveRoot = findSharedTarRootDirectory(regularFilePaths);
  const files: Record<string, string> = {};
  for (const [filePath, content] of textFiles) {
    const packagePath = archiveRoot
      ? filePath.slice(archiveRoot.length)
      : filePath;
    files[packagePath] = content;
  }

  return files;
}

/**
 * Read a TAR entry path, including the directory prefix from POSIX USTAR.
 */
function readTarEntryPath(header: Uint8Array): string {
  const name = readString(header, 0, 100);
  const isPosixUstar =
    readString(header, 257, 6) === "ustar" &&
    readString(header, 263, 2) === "00";

  if (!isPosixUstar) {
    return name;
  }

  const prefix = readString(header, 345, 155);
  return prefix === "" ? name : `${prefix}/${name}`;
}

/**
 * Normalize the current-directory prefix that tar writers may add to entries.
 */
function normalizeTarEntryPath(filePath: string): string {
  let normalizedPath = filePath;
  while (normalizedPath.startsWith("./")) {
    normalizedPath = normalizedPath.slice(2);
  }
  return normalizedPath;
}

/**
 * Return the enclosing tar directory shared by every regular file.
 *
 * npm clients remove one enclosing directory during extraction without
 * requiring it to be named `package`. If any file is already at the archive
 * root, or files have different roots, the archive is left unchanged.
 */
function findSharedTarRootDirectory(
  filePaths: readonly string[]
): string | undefined {
  let sharedRoot: string | undefined;

  for (const filePath of filePaths) {
    const separatorIndex = filePath.indexOf("/");
    if (separatorIndex <= 0) {
      return undefined;
    }

    const fileRoot = filePath.slice(0, separatorIndex + 1);
    if (sharedRoot === undefined) {
      sharedRoot = fileRoot;
    } else if (sharedRoot !== fileRoot) {
      return undefined;
    }
  }

  return sharedRoot;
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
