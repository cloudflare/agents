/**
 * tar - manipulate tape archives
 *
 * Supports creating, extracting, and listing tar archives
 * with optional gzip, bzip2, and xz compression.
 */

import { createUserRegex } from "../../regex/index";
import type { Command, CommandContext, ExecResult } from "../../types";
import { formatMode } from "../format-mode";
import { hasHelpFlag, showHelp } from "../help";
import {
  createArchive,
  createBzip2CompressedArchive,
  createCompressedArchive,
  createXzCompressedArchive,
  createZstdCompressedArchive,
  isBzip2Compressed,
  isGzipCompressed,
  isXzCompressed,
  isZstdCompressed,
  type ParsedEntry,
  parseArchive,
  parseBzip2CompressedArchive,
  parseCompressedArchive,
  parseXzCompressedArchive,
  parseZstdCompressedArchive,
  type TarCreateEntry
} from "./archive";
import { parseOptions, type TarOptions } from "./tar-options";

const BATCH_SIZE = 100;

const tarHelp = {
  name: "tar",
  summary: "manipulate tape archives",
  usage: "tar [options] [file...]",
  description: [
    "Create, extract, or list contents of tar archives.",
    "",
    "One of -c, -r, -u, -x, or -t is required to specify the operation."
  ],
  options: [
    "-c, --create           create a new archive",
    "-r, --append           append files to the end of an archive",
    "-u, --update           only append files newer than copy in archive",
    "-x, --extract          extract files from an archive",
    "-t, --list             list contents of an archive",
    "-f, --file=ARCHIVE     use archive file ARCHIVE",
    "-a, --auto-compress    use archive suffix to determine compression",
    "-z, --gzip             filter archive through gzip",
    "-j, --bzip2            filter archive through bzip2",
    "-J, --xz               filter archive through xz",
    "--zstd                 filter archive through zstd",
    "-v, --verbose          verbosely list files processed",
    "-O, --to-stdout        extract files to standard output",
    "-k, --keep-old-files   don't replace existing files when extracting",
    "-m, --touch            don't extract file modified time",
    "-C, --directory=DIR    change to directory DIR before performing operations",
    "-p, --preserve         preserve permissions",
    "-P, --absolute-names   do not strip leading '/' or block '..' paths",
    "-T, --files-from=FILE  read files to extract/create from FILE",
    "-X, --exclude-from=FILE read exclude patterns from FILE",
    "--strip=N              strip N leading path components on extraction",
    "--exclude=PATTERN      exclude files matching PATTERN",
    "--wildcards            use wildcards for pattern matching",
    "    --help             display this help and exit"
  ],
  examples: [
    "tar -cvf archive.tar file1 file2     Create archive from files",
    "tar -czvf archive.tar.gz dir/        Create gzip-compressed archive",
    "tar -cjvf archive.tar.bz2 dir/       Create bzip2-compressed archive",
    "tar -rf archive.tar newfile.txt      Append file to archive",
    "tar -uf archive.tar dir/             Update archive with newer files",
    "tar -xvf archive.tar                 Extract archive",
    "tar -xvf archive.tar -C /tmp         Extract to /tmp",
    "tar -tvf archive.tar                 List archive contents",
    "tar -xzf archive.tar.gz              Extract gzip archive",
    "tar -xf archive.tar file1.txt        Extract specific file",
    "tar -xOf archive.tar file.txt        Extract file to stdout",
    "tar -xf archive.tar --wildcards '*.txt'  Extract matching files"
  ]
};

/**
 * Check if a path matches any exclude pattern
 */
function matchesExclude(path: string, patterns: string[]): boolean {
  // Get the basename for patterns that don't include path separators
  const basename = path.includes("/")
    ? path.substring(path.lastIndexOf("/") + 1)
    : path;

  for (const pattern of patterns) {
    // Simple glob matching - supports * and **
    const regex = pattern
      .replace(/[.+^${}()|[\]\\]/g, "\\$&") // Escape special regex chars except * and ?
      .replace(/\*\*/g, "<<<GLOBSTAR>>>")
      .replace(/\*/g, "[^/]*")
      .replace(/<<<GLOBSTAR>>>/g, ".*")
      .replace(/\?/g, ".");

    // Check full path match
    if (
      createUserRegex(`^${regex}$`).test(path) ||
      createUserRegex(`^${regex}/`).test(path)
    ) {
      return true;
    }

    // Check basename match (for patterns like *.log)
    if (
      !pattern.includes("/") &&
      createUserRegex(`^${regex}$`).test(basename)
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Check if a name matches a wildcard pattern
 * Supports * and ? wildcards
 */
function matchesWildcard(name: string, pattern: string): boolean {
  // Convert glob pattern to regex
  const regex = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&") // Escape special regex chars except * and ?
    .replace(/\*\*/g, "<<<GLOBSTAR>>>")
    .replace(/\*/g, "[^/]*")
    .replace(/<<<GLOBSTAR>>>/g, ".*")
    .replace(/\?/g, ".");

  // Match against full path or basename
  const basename = name.includes("/")
    ? name.substring(name.lastIndexOf("/") + 1)
    : name;

  return (
    createUserRegex(`^${regex}$`).test(name) ||
    createUserRegex(`^${regex}$`).test(basename)
  );
}

/**
 * Strip leading path components from a path
 */
function stripComponents(path: string, count: number): string {
  if (count <= 0) return path;
  const parts = path.split("/").filter((p) => p !== "");
  if (parts.length <= count) return "";
  return parts.slice(count).join("/");
}

function hasParentTraversal(path: string): boolean {
  return path.split("/").some((part) => part === "..");
}

function sanitizeExtractionPath(
  path: string,
  absoluteNames: boolean
): { safePath?: string; error?: string } {
  if (absoluteNames) {
    return { safePath: path };
  }

  const withoutLeadingSlash = path.replace(/^\/+/, "");
  if (withoutLeadingSlash.length === 0) {
    return { safePath: "" };
  }
  if (hasParentTraversal(withoutLeadingSlash)) {
    return { error: "Path contains '..'" };
  }
  return { safePath: withoutLeadingSlash };
}

// formatMode imported from ../format-mode.js

/**
 * Format date for verbose output
 */
function formatDate(date: Date): string {
  const months = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec"
  ];
  const month = months[date.getMonth()];
  const day = date.getDate().toString().padStart(2, " ");
  const hours = date.getHours().toString().padStart(2, "0");
  const mins = date.getMinutes().toString().padStart(2, "0");
  return `${month} ${day} ${hours}:${mins}`;
}

/**
 * Collect all files from a directory recursively
 */
async function collectFiles(
  ctx: CommandContext,
  basePath: string,
  relativePath: string,
  exclude: string[]
): Promise<{ entries: TarCreateEntry[]; errors: string[] }> {
  const entries: TarCreateEntry[] = [];
  const errors: string[] = [];
  const fullPath = ctx.fs.resolvePath(basePath, relativePath);

  try {
    const stat = await ctx.fs.stat(fullPath);

    if (matchesExclude(relativePath, exclude)) {
      return { entries, errors };
    }

    if (stat.isDirectory) {
      // Add directory entry
      entries.push({
        name: relativePath,
        isDirectory: true,
        mode: stat.mode,
        mtime: stat.mtime
      });

      // Read directory contents
      const items = await ctx.fs.readdir(fullPath);

      // Process in batches
      for (let i = 0; i < items.length; i += BATCH_SIZE) {
        const batch = items.slice(i, i + BATCH_SIZE);
        const results = await Promise.all(
          batch.map((item) =>
            collectFiles(
              ctx,
              basePath,
              relativePath ? `${relativePath}/${item}` : item,
              exclude
            )
          )
        );
        for (const result of results) {
          entries.push(...result.entries);
          errors.push(...result.errors);
        }
      }
    } else if (stat.isFile) {
      // Read file content
      const content = await ctx.fs.readFileBuffer(fullPath);
      entries.push({
        name: relativePath,
        content,
        mode: stat.mode,
        mtime: stat.mtime
      });
    } else if (stat.isSymbolicLink) {
      // Read symlink target
      const target = await ctx.fs.readlink(fullPath);
      entries.push({
        name: relativePath,
        isSymlink: true,
        linkTarget: target,
        mode: stat.mode,
        mtime: stat.mtime
      });
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown error";
    errors.push(`tar: ${relativePath}: ${msg}`);
  }

  return { entries, errors };
}

/**
 * Create a tar archive
 */
async function createTarArchive(
  ctx: CommandContext,
  options: TarOptions,
  files: string[]
): Promise<ExecResult> {
  if (files.length === 0) {
    return {
      stdout: "",
      stderr: "tar: Cowardly refusing to create an empty archive\n",
      exitCode: 2
    };
  }

  const workDir = options.directory
    ? ctx.fs.resolvePath(ctx.cwd, options.directory)
    : ctx.cwd;

  // Collect all entries
  const allEntries: TarCreateEntry[] = [];
  const allErrors: string[] = [];
  let verboseOutput = "";

  for (const file of files) {
    const { entries, errors } = await collectFiles(
      ctx,
      workDir,
      file,
      options.exclude
    );
    allEntries.push(...entries);
    allErrors.push(...errors);

    if (options.verbose) {
      for (const entry of entries) {
        verboseOutput += `${entry.name}${entry.isDirectory ? "/" : ""}\n`;
      }
    }
  }

  if (allEntries.length === 0 && allErrors.length > 0) {
    return {
      stdout: "",
      stderr: `${allErrors.join("\n")}\n`,
      exitCode: 2
    };
  }

  // Create archive
  let archiveData: Uint8Array;
  try {
    if (options.gzip) {
      archiveData = await createCompressedArchive(allEntries);
    } else if (options.bzip2) {
      archiveData = await createBzip2CompressedArchive(allEntries);
    } else if (options.xz) {
      archiveData = await createXzCompressedArchive(allEntries);
    } else if (options.zstd) {
      archiveData = await createZstdCompressedArchive(allEntries);
    } else {
      archiveData = await createArchive(allEntries);
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown error";
    return {
      stdout: "",
      stderr: `tar: error creating archive: ${msg}\n`,
      exitCode: 2
    };
  }

  // Write archive
  let stdout = "";
  if (options.file && options.file !== "-") {
    const archivePath = ctx.fs.resolvePath(ctx.cwd, options.file);
    try {
      await ctx.fs.writeFile(archivePath, archiveData);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "unknown error";
      return {
        stdout: "",
        stderr: `tar: ${options.file}: ${msg}\n`,
        exitCode: 2
      };
    }
  } else {
    // Output to stdout as binary
    stdout = Buffer.from(archiveData).toString("latin1");
  }

  // Verbose output goes to stderr (like real tar)
  let stderr = verboseOutput;
  if (allErrors.length > 0) {
    stderr += `${allErrors.join("\n")}\n`;
  }
  return { stdout, stderr, exitCode: allErrors.length > 0 ? 2 : 0 };
}

/**
 * Append files to an existing tar archive (-r)
 */
async function appendTarArchive(
  ctx: CommandContext,
  options: TarOptions,
  files: string[]
): Promise<ExecResult> {
  if (!options.file || options.file === "-") {
    return {
      stdout: "",
      stderr: "tar: Cannot append to stdin/stdout\n",
      exitCode: 2
    };
  }

  if (files.length === 0) {
    return {
      stdout: "",
      stderr: "tar: Cowardly refusing to append nothing to archive\n",
      exitCode: 2
    };
  }

  const archivePath = ctx.fs.resolvePath(ctx.cwd, options.file);

  // Read existing archive
  let existingData: Uint8Array;
  try {
    existingData = await ctx.fs.readFileBuffer(archivePath);
  } catch {
    return {
      stdout: "",
      stderr: `tar: ${options.file}: Cannot open: No such file or directory\n`,
      exitCode: 2
    };
  }

  // Parse existing archive
  const parseResult = await parseArchive(existingData);
  if (parseResult.error) {
    return {
      stdout: "",
      stderr: `tar: ${parseResult.error}\n`,
      exitCode: 2
    };
  }

  // Convert existing entries to TarCreateEntry format
  const existingEntries: TarCreateEntry[] = parseResult.entries.map((e) => ({
    name: e.name,
    content: e.content,
    mode: e.mode,
    mtime: e.mtime,
    isDirectory: e.type === "directory",
    isSymlink: e.type === "symlink",
    linkTarget: e.linkTarget,
    uid: e.uid,
    gid: e.gid
  }));

  const workDir = options.directory
    ? ctx.fs.resolvePath(ctx.cwd, options.directory)
    : ctx.cwd;

  // Collect new entries
  const newEntries: TarCreateEntry[] = [];
  const allErrors: string[] = [];
  let verboseOutput = "";

  for (const file of files) {
    const { entries, errors } = await collectFiles(
      ctx,
      workDir,
      file,
      options.exclude
    );
    newEntries.push(...entries);
    allErrors.push(...errors);

    if (options.verbose) {
      for (const entry of entries) {
        verboseOutput += `${entry.name}${entry.isDirectory ? "/" : ""}\n`;
      }
    }
  }

  // Combine existing and new entries
  const allEntries = [...existingEntries, ...newEntries];

  // Create new archive
  let archiveData: Uint8Array;
  try {
    archiveData = await createArchive(allEntries);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown error";
    return {
      stdout: "",
      stderr: `tar: error creating archive: ${msg}\n`,
      exitCode: 2
    };
  }

  // Write archive
  try {
    await ctx.fs.writeFile(archivePath, archiveData);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown error";
    return {
      stdout: "",
      stderr: `tar: ${options.file}: ${msg}\n`,
      exitCode: 2
    };
  }

  let stderr = verboseOutput;
  if (allErrors.length > 0) {
    stderr += `${allErrors.join("\n")}\n`;
  }
  return { stdout: "", stderr, exitCode: allErrors.length > 0 ? 2 : 0 };
}

/**
 * Update archive with newer files (-u)
 */
async function updateTarArchive(
  ctx: CommandContext,
  options: TarOptions,
  files: string[]
): Promise<ExecResult> {
  if (!options.file || options.file === "-") {
    return {
      stdout: "",
      stderr: "tar: Cannot update stdin/stdout\n",
      exitCode: 2
    };
  }

  if (files.length === 0) {
    return {
      stdout: "",
      stderr: "tar: Cowardly refusing to update with nothing\n",
      exitCode: 2
    };
  }

  const archivePath = ctx.fs.resolvePath(ctx.cwd, options.file);

  // Read existing archive
  let existingData: Uint8Array;
  try {
    existingData = await ctx.fs.readFileBuffer(archivePath);
  } catch {
    return {
      stdout: "",
      stderr: `tar: ${options.file}: Cannot open: No such file or directory\n`,
      exitCode: 2
    };
  }

  // Parse existing archive
  const parseResult = await parseArchive(existingData);
  if (parseResult.error) {
    return {
      stdout: "",
      stderr: `tar: ${parseResult.error}\n`,
      exitCode: 2
    };
  }

  // Build a map of existing entries with their mtime
  const existingMtimes = new Map<string, Date>();
  for (const entry of parseResult.entries) {
    existingMtimes.set(entry.name, entry.mtime);
  }

  const workDir = options.directory
    ? ctx.fs.resolvePath(ctx.cwd, options.directory)
    : ctx.cwd;

  // Collect new entries, but only if they're newer
  const newEntries: TarCreateEntry[] = [];
  const allErrors: string[] = [];
  let verboseOutput = "";

  for (const file of files) {
    const { entries, errors } = await collectFiles(
      ctx,
      workDir,
      file,
      options.exclude
    );
    allErrors.push(...errors);

    for (const entry of entries) {
      const existingMtime = existingMtimes.get(entry.name);
      // Only include if it doesn't exist in archive or is newer
      if (
        !existingMtime ||
        (entry.mtime && entry.mtime.getTime() > existingMtime.getTime())
      ) {
        newEntries.push(entry);
        if (options.verbose) {
          verboseOutput += `${entry.name}${entry.isDirectory ? "/" : ""}\n`;
        }
      }
    }
  }

  if (newEntries.length === 0) {
    // Nothing to update
    let stderr = "";
    if (allErrors.length > 0) {
      stderr = `${allErrors.join("\n")}\n`;
    }
    return { stdout: "", stderr, exitCode: allErrors.length > 0 ? 2 : 0 };
  }

  // Convert existing entries to TarCreateEntry format, excluding ones we're updating
  const updatedNames = new Set(newEntries.map((e) => e.name));
  const existingEntries: TarCreateEntry[] = parseResult.entries
    .filter((e) => !updatedNames.has(e.name))
    .map((e) => ({
      name: e.name,
      content: e.content,
      mode: e.mode,
      mtime: e.mtime,
      isDirectory: e.type === "directory",
      isSymlink: e.type === "symlink",
      linkTarget: e.linkTarget,
      uid: e.uid,
      gid: e.gid
    }));

  // Combine existing and new entries
  const allEntries = [...existingEntries, ...newEntries];

  // Create new archive
  let archiveData: Uint8Array;
  try {
    archiveData = await createArchive(allEntries);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown error";
    return {
      stdout: "",
      stderr: `tar: error creating archive: ${msg}\n`,
      exitCode: 2
    };
  }

  // Write archive
  try {
    await ctx.fs.writeFile(archivePath, archiveData);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown error";
    return {
      stdout: "",
      stderr: `tar: ${options.file}: ${msg}\n`,
      exitCode: 2
    };
  }

  let stderr = verboseOutput;
  if (allErrors.length > 0) {
    stderr += `${allErrors.join("\n")}\n`;
  }
  return { stdout: "", stderr, exitCode: allErrors.length > 0 ? 2 : 0 };
}

/**
 * Extract a tar archive
 */
async function extractTarArchive(
  ctx: CommandContext,
  options: TarOptions,
  specificFiles: string[]
): Promise<ExecResult> {
  // Read archive
  let archiveData: Uint8Array;

  if (options.file && options.file !== "-") {
    const archivePath = ctx.fs.resolvePath(ctx.cwd, options.file);
    try {
      archiveData = await ctx.fs.readFileBuffer(archivePath);
    } catch {
      return {
        stdout: "",
        stderr: `tar: ${options.file}: Cannot open: No such file or directory\n`,
        exitCode: 2
      };
    }
  } else {
    // Read from stdin - convert binary string directly to bytes without UTF-8 re-encoding
    archiveData = Uint8Array.from(ctx.stdin, (c) => c.charCodeAt(0));
  }

  // Parse archive - auto-detect compression or use flags
  let parseResult: { entries: ParsedEntry[]; error?: string };

  const useGzip = options.gzip || isGzipCompressed(archiveData);
  const useBzip2 = options.bzip2 || isBzip2Compressed(archiveData);
  const useXz = options.xz || isXzCompressed(archiveData);
  const useZstd = options.zstd || isZstdCompressed(archiveData);

  if (useGzip) {
    parseResult = await parseCompressedArchive(archiveData);
  } else if (useBzip2) {
    parseResult = await parseBzip2CompressedArchive(archiveData);
  } else if (useXz) {
    parseResult = await parseXzCompressedArchive(archiveData);
  } else if (useZstd) {
    parseResult = await parseZstdCompressedArchive(archiveData);
  } else {
    parseResult = await parseArchive(archiveData);
  }

  if (parseResult.error) {
    return {
      stdout: "",
      stderr: `tar: ${parseResult.error}\n`,
      exitCode: 2
    };
  }

  const workDir = options.directory
    ? ctx.fs.resolvePath(ctx.cwd, options.directory)
    : ctx.cwd;
  const normalizedSpecificFiles = options.absoluteNames
    ? specificFiles
    : specificFiles
        .map((f) => f.replace(/^\/+/, ""))
        .filter((f) => f.length > 0);

  let verboseOutput = "";
  let stdoutContent = "";
  const errors: string[] = [];

  // Create target directory if it doesn't exist (only if not extracting to stdout)
  if (options.directory && !options.toStdout) {
    try {
      await ctx.fs.mkdir(workDir, { recursive: true });
    } catch {
      // Ignore - directory may already exist
    }
  }

  // Extract entries
  for (const entry of parseResult.entries) {
    // Apply strip-components
    const name = stripComponents(entry.name, options.strip);
    if (!name) continue;

    const sanitized = sanitizeExtractionPath(name, options.absoluteNames);
    if (sanitized.error) {
      errors.push(`tar: ${name}: ${sanitized.error}`);
      continue;
    }
    const safeName = sanitized.safePath ?? "";
    if (!safeName) continue;

    // Remove trailing slash for consistency
    const displayName = safeName.endsWith("/")
      ? safeName.slice(0, -1)
      : safeName;

    // Check if this file should be extracted (if specific files requested)
    if (normalizedSpecificFiles.length > 0) {
      let matches: boolean;
      if (options.wildcards) {
        // Use wildcard pattern matching
        matches = normalizedSpecificFiles.some(
          (f) =>
            matchesWildcard(safeName, f) ||
            matchesWildcard(displayName, f) ||
            safeName.startsWith(`${f}/`)
        );
      } else {
        // Exact match or prefix match
        matches = normalizedSpecificFiles.some(
          (f) =>
            safeName === f || safeName.startsWith(`${f}/`) || displayName === f
        );
      }
      if (!matches) continue;
    }

    // Check exclude patterns
    if (matchesExclude(safeName, options.exclude)) continue;

    const targetPath = ctx.fs.resolvePath(workDir, safeName);

    try {
      if (entry.type === "directory") {
        // Skip directories when extracting to stdout
        if (options.toStdout) continue;

        await ctx.fs.mkdir(targetPath, { recursive: true });
        if (options.verbose) {
          verboseOutput += `${safeName}\n`;
        }
      } else if (entry.type === "file") {
        // Handle -O (extract to stdout)
        if (options.toStdout) {
          stdoutContent += new TextDecoder().decode(entry.content);
          if (options.verbose) {
            verboseOutput += `${safeName}\n`;
          }
          continue;
        }

        // Check -k (keep old files) - skip if file already exists
        if (options.keepOldFiles) {
          try {
            await ctx.fs.stat(targetPath);
            if (options.verbose) {
              verboseOutput += `${safeName}: not overwritten, file exists\n`;
            }
            continue;
          } catch {
            // File doesn't exist, proceed with extraction
          }
        }

        // Ensure parent directory exists
        const parentDir = targetPath.substring(0, targetPath.lastIndexOf("/"));
        if (parentDir) {
          try {
            await ctx.fs.mkdir(parentDir, { recursive: true });
          } catch {
            // Ignore
          }
        }

        await ctx.fs.writeFile(targetPath, entry.content);

        // Set permissions if preserving
        if (options.preserve && entry.mode) {
          try {
            await ctx.fs.chmod(targetPath, entry.mode);
          } catch {
            // Ignore permission errors
          }
        }

        if (options.verbose) {
          verboseOutput += `${safeName}\n`;
        }
      } else if (entry.type === "symlink" && entry.linkTarget) {
        // Skip symlinks when extracting to stdout
        if (options.toStdout) continue;

        if (
          !options.absoluteNames &&
          (entry.linkTarget.startsWith("/") ||
            hasParentTraversal(entry.linkTarget))
        ) {
          errors.push(`tar: ${safeName}: unsafe symlink target`);
          continue;
        }

        // Check -k (keep old files)
        if (options.keepOldFiles) {
          try {
            await ctx.fs.stat(targetPath);
            if (options.verbose) {
              verboseOutput += `${safeName}: not overwritten, file exists\n`;
            }
            continue;
          } catch {
            // Doesn't exist, proceed
          }
        }

        // Ensure parent directory exists
        const parentDir = targetPath.substring(0, targetPath.lastIndexOf("/"));
        if (parentDir) {
          try {
            await ctx.fs.mkdir(parentDir, { recursive: true });
          } catch {
            // Ignore
          }
        }

        try {
          await ctx.fs.symlink(entry.linkTarget, targetPath);
        } catch {
          // Symlink may already exist
        }

        if (options.verbose) {
          verboseOutput += `${safeName}\n`;
        }
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : "unknown error";
      errors.push(`tar: ${safeName}: ${msg}`);
    }
  }

  // Verbose output goes to stderr (like real tar)
  let stderr = verboseOutput;
  if (errors.length > 0) {
    stderr += `${errors.join("\n")}\n`;
  }
  return { stdout: stdoutContent, stderr, exitCode: errors.length > 0 ? 2 : 0 };
}

/**
 * List contents of a tar archive
 */
async function listTarArchive(
  ctx: CommandContext,
  options: TarOptions,
  specificFiles: string[]
): Promise<ExecResult> {
  // Read archive
  let archiveData: Uint8Array;

  if (options.file && options.file !== "-") {
    const archivePath = ctx.fs.resolvePath(ctx.cwd, options.file);
    try {
      archiveData = await ctx.fs.readFileBuffer(archivePath);
    } catch {
      return {
        stdout: "",
        stderr: `tar: ${options.file}: Cannot open: No such file or directory\n`,
        exitCode: 2
      };
    }
  } else {
    // Read from stdin - convert binary string directly to bytes without UTF-8 re-encoding
    archiveData = Uint8Array.from(ctx.stdin, (c) => c.charCodeAt(0));
  }

  // Parse archive - auto-detect compression or use flags
  let parseResult: { entries: ParsedEntry[]; error?: string };

  const useGzip = options.gzip || isGzipCompressed(archiveData);
  const useBzip2 = options.bzip2 || isBzip2Compressed(archiveData);
  const useXz = options.xz || isXzCompressed(archiveData);
  const useZstd = options.zstd || isZstdCompressed(archiveData);

  if (useGzip) {
    parseResult = await parseCompressedArchive(archiveData);
  } else if (useBzip2) {
    parseResult = await parseBzip2CompressedArchive(archiveData);
  } else if (useXz) {
    parseResult = await parseXzCompressedArchive(archiveData);
  } else if (useZstd) {
    parseResult = await parseZstdCompressedArchive(archiveData);
  } else {
    parseResult = await parseArchive(archiveData);
  }

  if (parseResult.error) {
    return {
      stdout: "",
      stderr: `tar: ${parseResult.error}\n`,
      exitCode: 2
    };
  }

  let stdout = "";

  for (const entry of parseResult.entries) {
    // Apply strip-components for display
    const name = stripComponents(entry.name, options.strip);
    if (!name) continue;

    const displayName = name.endsWith("/") ? name.slice(0, -1) : name;

    // Check if this file should be listed (if specific files requested)
    if (specificFiles.length > 0) {
      let matches: boolean;
      if (options.wildcards) {
        matches = specificFiles.some(
          (f) =>
            matchesWildcard(name, f) ||
            matchesWildcard(displayName, f) ||
            name.startsWith(`${f}/`)
        );
      } else {
        matches = specificFiles.some(
          (f) => name === f || name.startsWith(`${f}/`) || displayName === f
        );
      }
      if (!matches) continue;
    }

    // Check exclude patterns
    if (matchesExclude(name, options.exclude)) continue;

    if (options.verbose) {
      // Verbose format: drwxr-xr-x user/group     0 Jan  1 00:00 name
      const isDir = entry.type === "directory";
      const mode = formatMode(entry.mode, isDir);
      const owner = `${entry.uid}/${entry.gid}`;
      const size = entry.size.toString().padStart(8, " ");
      const date = formatDate(entry.mtime);
      let line = `${mode} ${owner.padEnd(10)} ${size} ${date} ${name}`;
      if (entry.type === "symlink" && entry.linkTarget) {
        line += ` -> ${entry.linkTarget}`;
      }
      stdout += `${line}\n`;
    } else {
      stdout += `${name}\n`;
    }
  }

  return { stdout, stderr: "", exitCode: 0 };
}

export const tarCommand: Command = {
  name: "tar",
  async execute(args: string[], ctx: CommandContext): Promise<ExecResult> {
    if (hasHelpFlag(args)) {
      return showHelp(tarHelp);
    }

    const parsed = parseOptions(args);
    if (!parsed.ok) {
      return parsed.error;
    }

    const { options, files } = parsed;

    // Validate operation mode
    const opCount = [
      options.create,
      options.append,
      options.update,
      options.extract,
      options.list
    ].filter(Boolean).length;
    if (opCount === 0) {
      return {
        stdout: "",
        stderr: "tar: You must specify one of -c, -r, -u, -x, or -t\n",
        exitCode: 2
      };
    }
    if (opCount > 1) {
      return {
        stdout: "",
        stderr:
          "tar: You may not specify more than one of -c, -r, -u, -x, or -t\n",
        exitCode: 2
      };
    }

    // Handle auto-compress: determine compression from file extension
    if (options.autoCompress && options.file && options.create) {
      const file = options.file.toLowerCase();
      if (file.endsWith(".tar.gz") || file.endsWith(".tgz")) {
        options.gzip = true;
      } else if (file.endsWith(".tar.bz2") || file.endsWith(".tbz2")) {
        options.bzip2 = true;
      } else if (file.endsWith(".tar.xz") || file.endsWith(".txz")) {
        options.xz = true;
      } else if (file.endsWith(".tar.zst") || file.endsWith(".tzst")) {
        options.zstd = true;
      }
    }

    // Validate compression options - only one allowed
    const compCount = [
      options.gzip,
      options.bzip2,
      options.xz,
      options.zstd
    ].filter(Boolean).length;
    if (compCount > 1) {
      return {
        stdout: "",
        stderr: "tar: You may not specify more than one compression option\n",
        exitCode: 2
      };
    }

    // Append and update don't work with compression
    if ((options.append || options.update) && compCount > 0) {
      return {
        stdout: "",
        stderr:
          "tar: Cannot append/update compressed archives - decompress first\n",
        exitCode: 2
      };
    }

    // Handle files-from: read files from a file
    let finalFiles = files;
    if (options.filesFrom) {
      const filesFromPath = ctx.fs.resolvePath(ctx.cwd, options.filesFrom);
      try {
        const content = await ctx.fs.readFile(filesFromPath);
        const additionalFiles = content
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line.length > 0 && !line.startsWith("#"));
        finalFiles = [...files, ...additionalFiles];
      } catch {
        return {
          stdout: "",
          stderr: `tar: ${options.filesFrom}: Cannot open: No such file or directory\n`,
          exitCode: 2
        };
      }
    }

    // Handle exclude-from: read exclude patterns from a file
    if (options.excludeFrom) {
      const excludeFromPath = ctx.fs.resolvePath(ctx.cwd, options.excludeFrom);
      try {
        const content = await ctx.fs.readFile(excludeFromPath);
        const additionalExcludes = content
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line.length > 0 && !line.startsWith("#"));
        options.exclude.push(...additionalExcludes);
      } catch {
        return {
          stdout: "",
          stderr: `tar: ${options.excludeFrom}: Cannot open: No such file or directory\n`,
          exitCode: 2
        };
      }
    }

    if (options.create) {
      return createTarArchive(ctx, options, finalFiles);
    } else if (options.append) {
      return appendTarArchive(ctx, options, finalFiles);
    } else if (options.update) {
      return updateTarArchive(ctx, options, finalFiles);
    } else if (options.extract) {
      return extractTarArchive(ctx, options, finalFiles);
    } else {
      return listTarArchive(ctx, options, finalFiles);
    }
  }
};

import type { CommandFuzzInfo } from "../fuzz-flags-types";

export const flagsForFuzzing: CommandFuzzInfo = {
  name: "tar",
  flags: [
    { flag: "-c", type: "boolean" },
    { flag: "-x", type: "boolean" },
    { flag: "-t", type: "boolean" },
    { flag: "-f", type: "value", valueHint: "path" },
    { flag: "-z", type: "boolean" },
    { flag: "-j", type: "boolean" },
    { flag: "-v", type: "boolean" },
    { flag: "-C", type: "value", valueHint: "path" },
    { flag: "--strip-components", type: "value", valueHint: "number" },
    { flag: "--exclude", type: "value", valueHint: "pattern" }
  ],
  needsArgs: true
};
