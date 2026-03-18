import { createGlobMatcher, sortPaths } from "../helpers";
import { fromBuffer, getEncoding, toBuffer } from "./encoding";
import type {
  BufferEncoding,
  CpOptions,
  FileContent,
  FileEntry,
  FileInit,
  FileSystem,
  FileSystemDirent,
  FileSystemEntryType,
  FsEntry,
  FsStat,
  InitialFiles,
  LazyFileEntry,
  LazyFileProvider,
  MkdirOptions,
  ReadFileOptions,
  RmOptions,
  WriteFileOptions
} from "./interface";
import {
  DEFAULT_DIR_MODE,
  DEFAULT_FILE_MODE,
  dirname,
  joinPath,
  MAX_SYMLINK_DEPTH,
  normalizePath,
  resolvePath,
  resolveSymlinkTarget,
  SYMLINK_MODE,
  validatePath
} from "./path-utils";

export type { FileContent, FsEntry, FsStat, FileSystem };

export interface FsData {
  [path: string]: FsEntry;
}

const textEncoder = new TextEncoder();

function isFileInit(
  value: FileContent | FileInit | LazyFileProvider
): value is FileInit {
  return (
    typeof value === "object" &&
    value !== null &&
    !(value instanceof Uint8Array) &&
    "content" in value
  );
}

export class InMemoryFs implements FileSystem {
  private data: Map<string, FsEntry> = new Map();

  constructor(initialFiles?: InitialFiles) {
    this.data.set("/", {
      type: "directory",
      mode: DEFAULT_DIR_MODE,
      mtime: new Date()
    });

    if (initialFiles) {
      for (const [path, value] of Object.entries(initialFiles)) {
        if (typeof value === "function") {
          this.writeFileLazy(path, value);
        } else if (isFileInit(value)) {
          this.writeFileSync(path, value.content, undefined, {
            mode: value.mode,
            mtime: value.mtime
          });
        } else {
          this.writeFileSync(path, value);
        }
      }
    }
  }

  private ensureParentDirs(path: string): void {
    const dir = dirname(path);
    if (dir === "/") return;

    if (!this.data.has(dir)) {
      this.ensureParentDirs(dir);
      this.data.set(dir, {
        type: "directory",
        mode: DEFAULT_DIR_MODE,
        mtime: new Date()
      });
    }
  }

  writeFileSync(
    path: string,
    content: FileContent,
    options?: WriteFileOptions | BufferEncoding,
    metadata?: { mode?: number; mtime?: Date }
  ): void {
    validatePath(path, "write");
    const normalized = normalizePath(path);
    this.ensureParentDirs(normalized);

    const encoding = getEncoding(options);
    const buffer = toBuffer(content, encoding);

    this.data.set(normalized, {
      type: "file",
      content: buffer,
      mode: metadata?.mode ?? DEFAULT_FILE_MODE,
      mtime: metadata?.mtime ?? new Date()
    });
  }

  writeFileLazy(
    path: string,
    lazy: () => string | Uint8Array | Promise<string | Uint8Array>,
    metadata?: { mode?: number; mtime?: Date }
  ): void {
    validatePath(path, "write");
    const normalized = normalizePath(path);
    this.ensureParentDirs(normalized);

    this.data.set(normalized, {
      type: "file",
      lazy,
      mode: metadata?.mode ?? DEFAULT_FILE_MODE,
      mtime: metadata?.mtime ?? new Date()
    });
  }

  private async materializeLazy(
    path: string,
    entry: LazyFileEntry
  ): Promise<FileEntry> {
    const content = await entry.lazy();
    const buffer =
      typeof content === "string" ? textEncoder.encode(content) : content;
    const materialized: FileEntry = {
      type: "file",
      content: buffer,
      mode: entry.mode,
      mtime: entry.mtime
    };
    this.data.set(path, materialized);
    return materialized;
  }

  async readFile(
    path: string,
    options?: ReadFileOptions | BufferEncoding
  ): Promise<string> {
    const buffer = await this.readFileBytes(path);
    const encoding = getEncoding(options);
    return fromBuffer(buffer, encoding);
  }

  async readFileBytes(path: string): Promise<Uint8Array> {
    validatePath(path, "open");
    const resolvedPath = this.resolvePathWithSymlinks(path);
    const entry = this.data.get(resolvedPath);

    if (!entry) {
      throw new Error(`ENOENT: no such file or directory, open '${path}'`);
    }
    if (entry.type !== "file") {
      throw new Error(
        `EISDIR: illegal operation on a directory, read '${path}'`
      );
    }

    if ("lazy" in entry) {
      const materialized = await this.materializeLazy(resolvedPath, entry);
      return materialized.content instanceof Uint8Array
        ? materialized.content
        : textEncoder.encode(materialized.content);
    }

    return entry.content instanceof Uint8Array
      ? entry.content
      : textEncoder.encode(entry.content);
  }

  async writeFile(
    path: string,
    content: FileContent,
    options?: WriteFileOptions | BufferEncoding
  ): Promise<void> {
    this.writeFileSync(path, content, options);
  }

  async writeFileBytes(path: string, content: Uint8Array): Promise<void> {
    this.writeFileSync(path, content);
  }

  async appendFile(path: string, content: string | Uint8Array): Promise<void> {
    validatePath(path, "append");
    const normalized = normalizePath(path);
    const existing = this.data.get(normalized);

    if (existing && existing.type === "directory") {
      throw new Error(
        `EISDIR: illegal operation on a directory, write '${path}'`
      );
    }

    const newBuffer =
      content instanceof Uint8Array ? content : textEncoder.encode(content);

    if (existing?.type === "file") {
      let materialized = existing;
      if ("lazy" in materialized) {
        materialized = await this.materializeLazy(normalized, materialized);
      }

      const existingBuffer =
        "content" in materialized && materialized.content instanceof Uint8Array
          ? materialized.content
          : textEncoder.encode(
              "content" in materialized ? (materialized.content as string) : ""
            );

      const combined = new Uint8Array(existingBuffer.length + newBuffer.length);
      combined.set(existingBuffer);
      combined.set(newBuffer, existingBuffer.length);

      this.data.set(normalized, {
        type: "file",
        content: combined,
        mode: materialized.mode,
        mtime: new Date()
      });
    } else {
      this.writeFileSync(path, content);
    }
  }

  async exists(path: string): Promise<boolean> {
    if (path.includes("\0")) return false;
    try {
      const resolvedPath = this.resolvePathWithSymlinks(path);
      return this.data.has(resolvedPath);
    } catch {
      return false;
    }
  }

  async stat(path: string): Promise<FsStat> {
    validatePath(path, "stat");
    const resolvedPath = this.resolvePathWithSymlinks(path);
    let entry = this.data.get(resolvedPath);

    if (!entry) {
      throw new Error(`ENOENT: no such file or directory, stat '${path}'`);
    }

    if (entry.type === "file" && "lazy" in entry) {
      entry = await this.materializeLazy(resolvedPath, entry);
    }

    return this.toFsStat(entry, false);
  }

  async lstat(path: string): Promise<FsStat> {
    validatePath(path, "lstat");
    const resolvedPath = this.resolveIntermediateSymlinks(path);
    let entry = this.data.get(resolvedPath);

    if (!entry) {
      throw new Error(`ENOENT: no such file or directory, lstat '${path}'`);
    }

    if (entry.type === "symlink") {
      return {
        type: "symlink",
        size: entry.target.length,
        mtime: entry.mtime || new Date(),
        mode: entry.mode
      };
    }

    if (entry.type === "file" && "lazy" in entry) {
      entry = await this.materializeLazy(resolvedPath, entry);
    }

    return this.toFsStat(entry, false);
  }

  private toFsStat(entry: FsEntry, _isSymlink: boolean): FsStat {
    const type: FileSystemEntryType =
      entry.type === "file"
        ? "file"
        : entry.type === "directory"
          ? "directory"
          : "symlink";

    let size = 0;
    if (entry.type === "file" && "content" in entry && entry.content) {
      size =
        entry.content instanceof Uint8Array
          ? entry.content.length
          : textEncoder.encode(entry.content).length;
    } else if (entry.type === "symlink") {
      size = entry.target.length;
    }

    return {
      type,
      size,
      mtime: entry.mtime || new Date(),
      mode: entry.mode
    };
  }

  private resolveIntermediateSymlinks(path: string): string {
    const normalized = normalizePath(path);
    if (normalized === "/") return "/";

    const parts = normalized.slice(1).split("/");
    if (parts.length <= 1) return normalized;

    let resolvedPath = "";
    const seen = new Set<string>();

    for (let i = 0; i < parts.length - 1; i++) {
      resolvedPath = `${resolvedPath}/${parts[i]}`;

      let entry = this.data.get(resolvedPath);
      let loopCount = 0;

      while (
        entry &&
        entry.type === "symlink" &&
        loopCount < MAX_SYMLINK_DEPTH
      ) {
        if (seen.has(resolvedPath)) {
          throw new Error(
            `ELOOP: too many levels of symbolic links, lstat '${path}'`
          );
        }
        seen.add(resolvedPath);
        resolvedPath = resolveSymlinkTarget(resolvedPath, entry.target);
        entry = this.data.get(resolvedPath);
        loopCount++;
      }

      if (loopCount >= MAX_SYMLINK_DEPTH) {
        throw new Error(
          `ELOOP: too many levels of symbolic links, lstat '${path}'`
        );
      }
    }

    return `${resolvedPath}/${parts[parts.length - 1]}`;
  }

  private resolvePathWithSymlinks(path: string): string {
    const normalized = normalizePath(path);
    if (normalized === "/") return "/";

    const parts = normalized.slice(1).split("/");
    let resolvedPath = "";
    const seen = new Set<string>();

    for (const part of parts) {
      resolvedPath = `${resolvedPath}/${part}`;

      let entry = this.data.get(resolvedPath);
      let loopCount = 0;

      while (
        entry &&
        entry.type === "symlink" &&
        loopCount < MAX_SYMLINK_DEPTH
      ) {
        if (seen.has(resolvedPath)) {
          throw new Error(
            `ELOOP: too many levels of symbolic links, open '${path}'`
          );
        }
        seen.add(resolvedPath);
        resolvedPath = resolveSymlinkTarget(resolvedPath, entry.target);
        entry = this.data.get(resolvedPath);
        loopCount++;
      }

      if (loopCount >= MAX_SYMLINK_DEPTH) {
        throw new Error(
          `ELOOP: too many levels of symbolic links, open '${path}'`
        );
      }
    }

    return resolvedPath;
  }

  async mkdir(path: string, options?: MkdirOptions): Promise<void> {
    this.mkdirSync(path, options);
  }

  mkdirSync(path: string, options?: MkdirOptions): void {
    validatePath(path, "mkdir");
    const normalized = normalizePath(path);

    if (this.data.has(normalized)) {
      const entry = this.data.get(normalized);
      if (entry?.type === "file") {
        throw new Error(`EEXIST: file already exists, mkdir '${path}'`);
      }
      if (!options?.recursive) {
        throw new Error(`EEXIST: directory already exists, mkdir '${path}'`);
      }
      return;
    }

    const parent = dirname(normalized);
    if (parent !== "/" && !this.data.has(parent)) {
      if (options?.recursive) {
        this.mkdirSync(parent, { recursive: true });
      } else {
        throw new Error(`ENOENT: no such file or directory, mkdir '${path}'`);
      }
    }

    this.data.set(normalized, {
      type: "directory",
      mode: DEFAULT_DIR_MODE,
      mtime: new Date()
    });
  }

  async readdir(path: string): Promise<string[]> {
    const entries = await this.readdirWithFileTypes(path);
    return entries.map((e) => e.name);
  }

  async readdirWithFileTypes(path: string): Promise<FileSystemDirent[]> {
    validatePath(path, "scandir");
    let normalized = normalizePath(path);
    let entry = this.data.get(normalized);

    if (!entry) {
      throw new Error(`ENOENT: no such file or directory, scandir '${path}'`);
    }

    const seen = new Set<string>();
    while (entry && entry.type === "symlink") {
      if (seen.has(normalized)) {
        throw new Error(
          `ELOOP: too many levels of symbolic links, scandir '${path}'`
        );
      }
      seen.add(normalized);
      normalized = resolveSymlinkTarget(normalized, entry.target);
      entry = this.data.get(normalized);
    }

    if (!entry) {
      throw new Error(`ENOENT: no such file or directory, scandir '${path}'`);
    }
    if (entry.type !== "directory") {
      throw new Error(`ENOTDIR: not a directory, scandir '${path}'`);
    }

    const prefix = normalized === "/" ? "/" : `${normalized}/`;
    const entriesMap = new Map<string, FileSystemDirent>();

    for (const [p, fsEntry] of this.data.entries()) {
      if (p === normalized) continue;
      if (p.startsWith(prefix)) {
        const rest = p.slice(prefix.length);
        const name = rest.split("/")[0];
        if (name && !rest.includes("/", name.length) && !entriesMap.has(name)) {
          entriesMap.set(name, {
            name,
            type: fsEntry.type as FileSystemEntryType
          });
        }
      }
    }

    return Array.from(entriesMap.values()).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0
    );
  }

  async rm(path: string, options?: RmOptions): Promise<void> {
    validatePath(path, "rm");
    const normalized = normalizePath(path);
    const entry = this.data.get(normalized);

    if (!entry) {
      if (options?.force) return;
      throw new Error(`ENOENT: no such file or directory, rm '${path}'`);
    }

    if (entry.type === "directory") {
      const children = await this.readdir(normalized);
      if (children.length > 0) {
        if (!options?.recursive) {
          throw new Error(`ENOTEMPTY: directory not empty, rm '${path}'`);
        }
        for (const child of children) {
          await this.rm(joinPath(normalized, child), options);
        }
      }
    }

    this.data.delete(normalized);
  }

  async cp(src: string, dest: string, options?: CpOptions): Promise<void> {
    validatePath(src, "cp");
    validatePath(dest, "cp");
    const srcNorm = normalizePath(src);
    const destNorm = normalizePath(dest);
    const srcEntry = this.data.get(srcNorm);

    if (!srcEntry) {
      throw new Error(`ENOENT: no such file or directory, cp '${src}'`);
    }

    if (srcEntry.type === "file") {
      this.ensureParentDirs(destNorm);
      if ("content" in srcEntry) {
        const contentCopy =
          srcEntry.content instanceof Uint8Array
            ? new Uint8Array(srcEntry.content)
            : srcEntry.content;
        this.data.set(destNorm, { ...srcEntry, content: contentCopy });
      } else {
        this.data.set(destNorm, { ...srcEntry });
      }
    } else if (srcEntry.type === "symlink") {
      this.ensureParentDirs(destNorm);
      this.data.set(destNorm, { ...srcEntry });
    } else if (srcEntry.type === "directory") {
      if (!options?.recursive) {
        throw new Error(`EISDIR: is a directory, cp '${src}'`);
      }
      await this.mkdir(destNorm, { recursive: true });
      for (const child of await this.readdir(srcNorm)) {
        await this.cp(
          joinPath(srcNorm, child),
          joinPath(destNorm, child),
          options
        );
      }
    }
  }

  async mv(src: string, dest: string): Promise<void> {
    await this.cp(src, dest, { recursive: true });
    await this.rm(src, { recursive: true });
  }

  async symlink(target: string, linkPath: string): Promise<void> {
    validatePath(linkPath, "symlink");
    const normalized = normalizePath(linkPath);

    if (this.data.has(normalized)) {
      throw new Error(`EEXIST: file already exists, symlink '${linkPath}'`);
    }

    this.ensureParentDirs(normalized);
    this.data.set(normalized, {
      type: "symlink",
      target,
      mode: SYMLINK_MODE,
      mtime: new Date()
    });
  }

  async link(existingPath: string, newPath: string): Promise<void> {
    validatePath(existingPath, "link");
    validatePath(newPath, "link");
    const existingNorm = normalizePath(existingPath);
    const newNorm = normalizePath(newPath);

    const entry = this.data.get(existingNorm);
    if (!entry) {
      throw new Error(
        `ENOENT: no such file or directory, link '${existingPath}'`
      );
    }
    if (entry.type !== "file") {
      throw new Error(`EPERM: operation not permitted, link '${existingPath}'`);
    }
    if (this.data.has(newNorm)) {
      throw new Error(`EEXIST: file already exists, link '${newPath}'`);
    }

    let resolved = entry;
    if ("lazy" in resolved) {
      resolved = await this.materializeLazy(existingNorm, resolved);
    }

    this.ensureParentDirs(newNorm);
    this.data.set(newNorm, {
      type: "file",
      content: (resolved as FileEntry).content,
      mode: resolved.mode,
      mtime: resolved.mtime
    });
  }

  async readlink(path: string): Promise<string> {
    validatePath(path, "readlink");
    const normalized = normalizePath(path);
    const entry = this.data.get(normalized);

    if (!entry) {
      throw new Error(`ENOENT: no such file or directory, readlink '${path}'`);
    }
    if (entry.type !== "symlink") {
      throw new Error(`EINVAL: invalid argument, readlink '${path}'`);
    }

    return entry.target;
  }

  async realpath(path: string): Promise<string> {
    validatePath(path, "realpath");
    const resolved = this.resolvePathWithSymlinks(path);

    if (!this.data.has(resolved)) {
      throw new Error(`ENOENT: no such file or directory, realpath '${path}'`);
    }

    return resolved;
  }

  resolvePath(base: string, path: string): string {
    return resolvePath(base, path);
  }

  async glob(pattern: string): Promise<string[]> {
    const matcher = createGlobMatcher(pattern);
    const paths = Array.from(this.data.keys()).filter(
      (p) => p !== "/" && matcher.test(p)
    );
    return sortPaths(paths);
  }

  async chmod(path: string, mode: number): Promise<void> {
    validatePath(path, "chmod");
    const normalized = normalizePath(path);
    const entry = this.data.get(normalized);

    if (!entry) {
      throw new Error(`ENOENT: no such file or directory, chmod '${path}'`);
    }

    entry.mode = mode;
  }

  async utimes(path: string, _atime: Date, mtime: Date): Promise<void> {
    validatePath(path, "utimes");
    const normalized = normalizePath(path);
    const resolved = this.resolvePathWithSymlinks(normalized);
    const entry = this.data.get(resolved);

    if (!entry) {
      throw new Error(`ENOENT: no such file or directory, utimes '${path}'`);
    }

    entry.mtime = mtime;
  }
}
