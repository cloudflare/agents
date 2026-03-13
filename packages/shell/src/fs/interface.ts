/**
 * Supported buffer encodings
 */
export type BufferEncoding =
  | "utf8"
  | "utf-8"
  | "ascii"
  | "binary"
  | "base64"
  | "hex"
  | "latin1";

/**
 * File content can be string or Buffer
 */
export type FileContent = string | Uint8Array;

/**
 * Options for reading files
 */
export interface ReadFileOptions {
  encoding?: BufferEncoding | null;
}

/**
 * Options for writing files
 */
export interface WriteFileOptions {
  encoding?: BufferEncoding;
}

/**
 * File system entry types
 */
export interface FileEntry {
  type: "file";
  content: string | Uint8Array;
  mode: number;
  mtime: Date;
}

export interface DirectoryEntry {
  type: "directory";
  mode: number;
  mtime: Date;
}

export interface SymlinkEntry {
  type: "symlink";
  target: string; // The path this symlink points to
  mode: number;
  mtime: Date;
}

export interface LazyFileEntry {
  type: "file";
  lazy: () => string | Uint8Array | Promise<string | Uint8Array>;
  mode: number;
  mtime: Date;
}

export type FsEntry = FileEntry | LazyFileEntry | DirectoryEntry | SymlinkEntry;

/**
 * Directory entry with type information (similar to Node's Dirent)
 * Used by readdirWithFileTypes for efficient directory listing without stat calls
 */
export interface DirentEntry {
  name: string;
  isFile: boolean;
  isDirectory: boolean;
  isSymbolicLink: boolean;
}

/**
 * Stat result from the filesystem
 */
export interface FsStat {
  isFile: boolean;
  isDirectory: boolean;
  isSymbolicLink: boolean;
  mode: number;
  size: number;
  mtime: Date;
}

/**
 * Options for mkdir operation
 */
export interface MkdirOptions {
  recursive?: boolean;
}

/**
 * Options for rm operation
 */
export interface RmOptions {
  recursive?: boolean;
  force?: boolean;
}

/**
 * Options for cp operation
 */
export interface CpOptions {
  recursive?: boolean;
}

/**
 * Abstract filesystem interface that can be implemented by different backends.
 * This allows BashEnv to work with:
 * - InMemoryFs (in-memory, default)
 * - Real filesystem (via node:fs)
 * - Custom implementations (e.g., remote storage, browser IndexedDB)
 */
export interface IFileSystem {
  // Note: Sync method are not supported and must not be added.
  /**
   * Read the contents of a file as a string (default: utf8)
   * @throws Error if file doesn't exist or is a directory
   */
  readFile(
    path: string,
    options?: ReadFileOptions | BufferEncoding
  ): Promise<string>;

  /**
   * Read the contents of a file as a Uint8Array (binary)
   * @throws Error if file doesn't exist or is a directory
   */
  readFileBuffer(path: string): Promise<Uint8Array>;

  /**
   * Write content to a file, creating it if it doesn't exist
   */
  writeFile(
    path: string,
    content: FileContent,
    options?: WriteFileOptions | BufferEncoding
  ): Promise<void>;

  /**
   * Append content to a file, creating it if it doesn't exist
   */
  appendFile(
    path: string,
    content: FileContent,
    options?: WriteFileOptions | BufferEncoding
  ): Promise<void>;

  /**
   * Check if a path exists
   */
  exists(path: string): Promise<boolean>;

  /**
   * Get file/directory information
   * @throws Error if path doesn't exist
   */
  stat(path: string): Promise<FsStat>;

  /**
   * Create a directory
   * @throws Error if parent doesn't exist (unless recursive) or path exists
   */
  mkdir(path: string, options?: MkdirOptions): Promise<void>;

  /**
   * Read directory contents
   * @returns Array of entry names (not full paths)
   * @throws Error if path doesn't exist or is not a directory
   */
  readdir(path: string): Promise<string[]>;

  /**
   * Read directory contents with file type information (optional)
   * This is more efficient than readdir + stat for each entry
   * @returns Array of DirentEntry objects with name and type
   * @throws Error if path doesn't exist or is not a directory
   */
  readdirWithFileTypes?(path: string): Promise<DirentEntry[]>;

  /**
   * Remove a file or directory
   * @throws Error if path doesn't exist (unless force) or directory not empty (unless recursive)
   */
  rm(path: string, options?: RmOptions): Promise<void>;

  /**
   * Copy a file or directory
   * @throws Error if source doesn't exist or trying to copy directory without recursive
   */
  cp(src: string, dest: string, options?: CpOptions): Promise<void>;

  /**
   * Move/rename a file or directory
   */
  mv(src: string, dest: string): Promise<void>;

  /**
   * Resolve a relative path against a base path
   */
  resolvePath(base: string, path: string): string;

  /**
   * Get all paths in the filesystem (useful for glob matching)
   * Optional - implementations may return empty array if not supported
   */
  getAllPaths(): string[];

  /**
   * Change file/directory permissions
   * @throws Error if path doesn't exist
   */
  chmod(path: string, mode: number): Promise<void>;

  /**
   * Create a symbolic link
   * @param target - The path the symlink should point to
   * @param linkPath - The path where the symlink will be created
   * @throws Error if linkPath already exists
   */
  symlink(target: string, linkPath: string): Promise<void>;

  /**
   * Create a hard link
   * @param existingPath - The existing file to link to
   * @param newPath - The path where the new link will be created
   * @throws Error if existingPath doesn't exist or newPath already exists
   */
  link(existingPath: string, newPath: string): Promise<void>;

  /**
   * Read the target of a symbolic link
   * @throws Error if path doesn't exist or is not a symlink
   */
  readlink(path: string): Promise<string>;

  /**
   * Get file/directory information without following symlinks
   * @throws Error if path doesn't exist
   */
  lstat(path: string): Promise<FsStat>;

  /**
   * Resolve all symlinks in a path to get the canonical physical path.
   * This is equivalent to POSIX realpath() - it resolves all symlinks
   * in the path and returns the absolute physical path.
   * Used by pwd -P and cd -P for symlink resolution.
   * @throws Error if path doesn't exist or contains a broken symlink
   */
  realpath(path: string): Promise<string>;

  /**
   * Set access and modification times of a file
   * @param path - The file path
   * @param atime - Access time (currently ignored, kept for API compatibility)
   * @param mtime - Modification time
   * @throws Error if path doesn't exist
   */
  utimes(path: string, atime: Date, mtime: Date): Promise<void>;
}

/**
 * Extended file initialization options with optional metadata
 */
export interface FileInit {
  content: FileContent;
  mode?: number;
  mtime?: Date;
}

/**
 * Lazy file provider - a function whose return value becomes the file content on first read
 */
export type LazyFileProvider = () =>
  | string
  | Uint8Array
  | Promise<string | Uint8Array>;

/**
 * Initial files can be simple content, extended options with metadata, or lazy providers
 */
export type InitialFiles = Record<
  string,
  FileContent | FileInit | LazyFileProvider
>;

/**
 * Factory function type for creating filesystem instances
 */
export type FileSystemFactory = (initialFiles?: InitialFiles) => IFileSystem;
