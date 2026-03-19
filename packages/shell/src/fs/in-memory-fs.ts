import { createGlobMatcher, sortPaths } from "../helpers";
import { fromBuffer, getEncoding, toBuffer } from "./encoding";
import type {
  BufferEncoding,
  CpOptions,
  FileContent,
  FileInit,
  FileSystem,
  FileSystemDirent,
  FileSystemEntryType,
  FsEntry,
  FsStat,
  InitialFiles,
  LazyFileProvider,
  MkdirOptions,
  ReadFileOptions,
  RmOptions,
  WriteFileOptions
} from "./interface";
import {
  DEFAULT_DIR_MODE,
  DEFAULT_FILE_MODE,
  MAX_SYMLINK_DEPTH,
  normalizePath,
  resolvePath,
  SYMLINK_MODE,
  validatePath
} from "./path-utils";

export type { FileContent, FsEntry, FsStat, FileSystem };

export interface FsData {
  [path: string]: FsEntry;
}

// ── Tree node types ──────────────────────────────────────────────────
//
// Storage is a rooted tree where each directory holds a Map of its
// children.  This gives O(children) directory listing and natural
// recursive operations instead of scanning every key in a flat map.

interface VFileNode {
  kind: "file";
  bytes: Uint8Array;
  mode: number;
  mtime: Date;
}

interface VLazyNode {
  kind: "lazy";
  provider: () => string | Uint8Array | Promise<string | Uint8Array>;
  mode: number;
  mtime: Date;
}

interface VDirNode {
  kind: "dir";
  children: Map<string, VNode>;
  mode: number;
  mtime: Date;
}

interface VSymlinkNode {
  kind: "symlink";
  target: string;
  mode: number;
  mtime: Date;
}

type VNode = VFileNode | VLazyNode | VDirNode | VSymlinkNode;

interface Located {
  node: VNode;
  parent: VDirNode;
  key: string;
}

const utf8 = new TextEncoder();

function split(normalized: string): string[] {
  return normalized === "/" ? [] : normalized.slice(1).split("/");
}

function freshDir(): VDirNode {
  return {
    kind: "dir",
    children: new Map(),
    mode: DEFAULT_DIR_MODE,
    mtime: new Date()
  };
}

function kindToType(node: VNode): FileSystemEntryType {
  if (node.kind === "file" || node.kind === "lazy") return "file";
  if (node.kind === "dir") return "directory";
  return "symlink";
}

function nodeSize(node: VNode): number {
  if (node.kind === "file") return node.bytes.length;
  if (node.kind === "symlink") return node.target.length;
  return 0;
}

function isInitObj(
  v: FileContent | FileInit | LazyFileProvider
): v is FileInit {
  return (
    typeof v === "object" &&
    v !== null &&
    !(v instanceof Uint8Array) &&
    "content" in v
  );
}

export class InMemoryFs implements FileSystem {
  private tree: VDirNode;

  constructor(initialFiles?: InitialFiles) {
    this.tree = freshDir();
    if (!initialFiles) return;
    for (const [p, v] of Object.entries(initialFiles)) {
      if (typeof v === "function") {
        this.insertLazy(p, v);
      } else if (isInitObj(v)) {
        this.insertContent(
          p,
          v.content,
          getEncoding(undefined),
          v.mode,
          v.mtime
        );
      } else {
        this.insertContent(p, v);
      }
    }
  }

  // ── Sync helpers (used by consumers and constructor) ────────────────

  writeFileSync(
    path: string,
    content: FileContent,
    options?: WriteFileOptions | BufferEncoding,
    metadata?: { mode?: number; mtime?: Date }
  ): void {
    this.insertContent(
      path,
      content,
      getEncoding(options),
      metadata?.mode,
      metadata?.mtime
    );
  }

  writeFileLazy(
    path: string,
    lazy: () => string | Uint8Array | Promise<string | Uint8Array>,
    metadata?: { mode?: number; mtime?: Date }
  ): void {
    this.insertLazy(path, lazy, metadata?.mode, metadata?.mtime);
  }

  mkdirSync(path: string, options?: MkdirOptions): void {
    validatePath(path, "mkdir");
    const norm = normalizePath(path);
    if (norm === "/") {
      if (!options?.recursive) {
        throw new Error(`EEXIST: directory already exists, mkdir '${path}'`);
      }
      return;
    }
    const segs = split(norm);
    let dir = this.tree;
    for (let i = 0; i < segs.length; i++) {
      const last = i === segs.length - 1;
      const child = dir.children.get(segs[i]);
      if (child) {
        if (child.kind === "dir") {
          if (last) {
            if (!options?.recursive) {
              throw new Error(
                `EEXIST: directory already exists, mkdir '${path}'`
              );
            }
            return;
          }
          dir = child;
        } else if (last) {
          throw new Error(`EEXIST: file already exists, mkdir '${path}'`);
        } else if (options?.recursive) {
          const d = freshDir();
          dir.children.set(segs[i], d);
          dir = d;
        } else {
          throw new Error(`ENOENT: no such file or directory, mkdir '${path}'`);
        }
      } else if (last) {
        dir.children.set(segs[i], freshDir());
      } else if (options?.recursive) {
        const d = freshDir();
        dir.children.set(segs[i], d);
        dir = d;
      } else {
        throw new Error(`ENOENT: no such file or directory, mkdir '${path}'`);
      }
    }
  }

  // ── FileSystem interface ───────────────────────────────────────────

  async readFile(
    path: string,
    options?: ReadFileOptions | BufferEncoding
  ): Promise<string> {
    return fromBuffer(await this.readFileBytes(path), getEncoding(options));
  }

  async readFileBytes(path: string): Promise<Uint8Array> {
    validatePath(path, "open");
    if (normalizePath(path) === "/") {
      throw new Error(
        `EISDIR: illegal operation on a directory, read '${path}'`
      );
    }
    const loc = this.locate(path, true, "open");
    if (!loc) throw this.missing("open", path);
    if (loc.node.kind === "dir" || loc.node.kind === "symlink") {
      throw new Error(
        `EISDIR: illegal operation on a directory, read '${path}'`
      );
    }
    if (loc.node.kind === "lazy") return this.forceLazy(loc);
    return loc.node.bytes;
  }

  async writeFile(
    path: string,
    content: string,
    options?: WriteFileOptions | BufferEncoding
  ): Promise<void> {
    this.insertContent(path, content, getEncoding(options));
  }

  async writeFileBytes(path: string, content: Uint8Array): Promise<void> {
    this.insertContent(path, content);
  }

  async appendFile(path: string, content: string | Uint8Array): Promise<void> {
    validatePath(path, "append");
    const extra = typeof content === "string" ? utf8.encode(content) : content;
    const loc = this.locate(path, true, "append");

    if (loc?.node.kind === "dir") {
      throw new Error(
        `EISDIR: illegal operation on a directory, write '${path}'`
      );
    }

    if (!loc) {
      this.insertContent(path, content);
      return;
    }

    let existing: Uint8Array;
    if (loc.node.kind === "lazy") {
      existing = await this.forceLazy(loc);
    } else if (loc.node.kind === "file") {
      existing = loc.node.bytes;
    } else {
      this.insertContent(path, content);
      return;
    }

    const merged = new Uint8Array(existing.length + extra.length);
    merged.set(existing);
    merged.set(extra, existing.length);

    const fresh = loc.parent.children.get(loc.key);
    if (fresh && fresh.kind === "file") {
      fresh.bytes = merged;
      fresh.mtime = new Date();
    }
  }

  async exists(path: string): Promise<boolean> {
    if (path.includes("\0")) return false;
    try {
      if (normalizePath(path) === "/") return true;
      return this.locate(path, true, "access") !== null;
    } catch {
      return false;
    }
  }

  async stat(path: string): Promise<FsStat> {
    validatePath(path, "stat");
    if (normalizePath(path) === "/") {
      return {
        type: "directory",
        size: 0,
        mtime: this.tree.mtime,
        mode: this.tree.mode
      };
    }
    const loc = this.locate(path, true, "stat");
    if (!loc) throw this.missing("stat", path);
    if (loc.node.kind === "lazy") await this.forceLazy(loc);
    const n = loc.parent.children.get(loc.key);
    if (!n) throw this.missing("stat", path);
    return {
      type: kindToType(n),
      size: nodeSize(n),
      mtime: n.mtime,
      mode: n.mode
    };
  }

  async lstat(path: string): Promise<FsStat> {
    validatePath(path, "lstat");
    if (normalizePath(path) === "/") {
      return {
        type: "directory",
        size: 0,
        mtime: this.tree.mtime,
        mode: this.tree.mode
      };
    }
    const loc = this.locate(path, false, "lstat");
    if (!loc) throw this.missing("lstat", path);
    if (loc.node.kind === "symlink") {
      return {
        type: "symlink",
        size: loc.node.target.length,
        mtime: loc.node.mtime,
        mode: loc.node.mode
      };
    }
    if (loc.node.kind === "lazy") await this.forceLazy(loc);
    const n = loc.parent.children.get(loc.key);
    if (!n) throw this.missing("lstat", path);
    return {
      type: kindToType(n),
      size: nodeSize(n),
      mtime: n.mtime,
      mode: n.mode
    };
  }

  async mkdir(path: string, options?: MkdirOptions): Promise<void> {
    this.mkdirSync(path, options);
  }

  async readdir(path: string): Promise<string[]> {
    return (await this.readdirWithFileTypes(path)).map((d) => d.name);
  }

  async readdirWithFileTypes(path: string): Promise<FileSystemDirent[]> {
    validatePath(path, "scandir");
    const dir = this.resolveNode(path, true, "scandir");
    if (!dir) throw this.missing("scandir", path);
    if (dir.kind !== "dir") {
      throw new Error(`ENOTDIR: not a directory, scandir '${path}'`);
    }
    const out: FileSystemDirent[] = [];
    for (const [name, child] of dir.children) {
      out.push({ name, type: kindToType(child) });
    }
    return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  async rm(path: string, options?: RmOptions): Promise<void> {
    validatePath(path, "rm");
    const segs = split(normalizePath(path));
    if (segs.length === 0) {
      if (options?.force) return;
      throw new Error(`EPERM: cannot remove root, rm '${path}'`);
    }

    let dir = this.tree;
    for (let i = 0; i < segs.length - 1; i++) {
      const next = dir.children.get(segs[i]);
      if (!next || next.kind !== "dir") {
        if (options?.force) return;
        throw this.missing("rm", path);
      }
      dir = next;
    }

    const name = segs[segs.length - 1];
    const target = dir.children.get(name);
    if (!target) {
      if (options?.force) return;
      throw this.missing("rm", path);
    }
    if (
      target.kind === "dir" &&
      target.children.size > 0 &&
      !options?.recursive
    ) {
      throw new Error(`ENOTEMPTY: directory not empty, rm '${path}'`);
    }
    dir.children.delete(name);
  }

  async cp(src: string, dest: string, options?: CpOptions): Promise<void> {
    validatePath(src, "cp");
    validatePath(dest, "cp");
    const srcNode = this.resolveNode(src, true, "cp");
    if (!srcNode) throw this.missing("cp", src);
    if (srcNode.kind === "dir" && !options?.recursive) {
      throw new Error(`EISDIR: is a directory, cp '${src}'`);
    }
    this.placeNode(normalizePath(dest), this.deepClone(srcNode));
  }

  async mv(src: string, dest: string): Promise<void> {
    await this.cp(src, dest, { recursive: true });
    await this.rm(src, { recursive: true });
  }

  async symlink(target: string, linkPath: string): Promise<void> {
    validatePath(linkPath, "symlink");
    const segs = split(normalizePath(linkPath));
    const parent = this.scaffold(segs);
    const name = segs[segs.length - 1];
    if (parent.children.has(name)) {
      throw new Error(`EEXIST: file already exists, symlink '${linkPath}'`);
    }
    parent.children.set(name, {
      kind: "symlink",
      target,
      mode: SYMLINK_MODE,
      mtime: new Date()
    });
  }

  async link(existingPath: string, newPath: string): Promise<void> {
    validatePath(existingPath, "link");
    validatePath(newPath, "link");
    const srcLoc = this.locate(existingPath, true, "link");
    if (!srcLoc) throw this.missing("link", existingPath);
    if (srcLoc.node.kind !== "file" && srcLoc.node.kind !== "lazy") {
      throw new Error(`EPERM: operation not permitted, link '${existingPath}'`);
    }
    const segs = split(normalizePath(newPath));
    const parent = this.scaffold(segs);
    const name = segs[segs.length - 1];
    if (parent.children.has(name)) {
      throw new Error(`EEXIST: file already exists, link '${newPath}'`);
    }
    let bytes: Uint8Array;
    if (srcLoc.node.kind === "lazy") {
      bytes = await this.forceLazy(srcLoc);
    } else {
      bytes = srcLoc.node.bytes;
    }
    parent.children.set(name, {
      kind: "file",
      bytes,
      mode: srcLoc.node.mode,
      mtime: srcLoc.node.mtime
    });
  }

  async readlink(path: string): Promise<string> {
    validatePath(path, "readlink");
    const loc = this.locate(path, false, "readlink");
    if (!loc) throw this.missing("readlink", path);
    if (loc.node.kind !== "symlink") {
      throw new Error(`EINVAL: invalid argument, readlink '${path}'`);
    }
    return loc.node.target;
  }

  async realpath(path: string): Promise<string> {
    validatePath(path, "realpath");
    const canon = this.canonicalize(path);
    if (canon === null) throw this.missing("realpath", path);
    return canon;
  }

  resolvePath(base: string, path: string): string {
    return resolvePath(base, path);
  }

  async glob(pattern: string): Promise<string[]> {
    const re = createGlobMatcher(pattern);
    const hits: string[] = [];
    this.gather(this.tree, "", re, hits);
    return sortPaths(hits);
  }

  async chmod(path: string, mode: number): Promise<void> {
    validatePath(path, "chmod");
    const node = this.resolveNode(path, true, "chmod");
    if (!node) throw this.missing("chmod", path);
    node.mode = mode;
  }

  async utimes(path: string, _atime: Date, mtime: Date): Promise<void> {
    validatePath(path, "utimes");
    const node = this.resolveNode(path, true, "utimes");
    if (!node) throw this.missing("utimes", path);
    node.mtime = mtime;
  }

  // ── Tree traversal ─────────────────────────────────────────────────
  //
  // Symlinks are resolved via a pending-segment stack: when a symlink
  // is encountered, its target segments replace the current position
  // and traversal restarts from root.  This avoids the string-key
  // lookups of a flat map and naturally handles chained symlinks.

  private resolveNode(
    rawPath: string,
    followLast: boolean,
    op: string
  ): VNode | null {
    if (normalizePath(rawPath) === "/") return this.tree;
    const loc = this.locate(rawPath, followLast, op);
    return loc ? loc.node : null;
  }

  private locate(
    rawPath: string,
    followLast: boolean,
    op: string
  ): Located | null {
    const norm = normalizePath(rawPath);
    if (norm === "/") return null;

    const pending = split(norm);
    const trail: string[] = [];
    let dir = this.tree;
    let budget = MAX_SYMLINK_DEPTH;

    while (pending.length > 0) {
      const seg = pending.shift()!;
      const child = dir.children.get(seg);
      if (!child) return null;

      const last = pending.length === 0;

      if (child.kind === "symlink" && (!last || followLast)) {
        if (--budget < 0) {
          throw new Error(
            `ELOOP: too many levels of symbolic links, ${op} '${rawPath}'`
          );
        }
        const base = trail.length > 0 ? "/" + trail.join("/") : "";
        const abs = child.target.startsWith("/")
          ? normalizePath(child.target)
          : normalizePath(base + "/" + child.target);
        pending.unshift(...split(abs));
        trail.length = 0;
        dir = this.tree;
        continue;
      }

      if (last) return { node: child, parent: dir, key: seg };
      if (child.kind !== "dir") return null;

      trail.push(seg);
      dir = child;
    }

    return null;
  }

  private canonicalize(rawPath: string): string | null {
    const norm = normalizePath(rawPath);
    if (norm === "/") return "/";

    const pending = split(norm);
    const resolved: string[] = [];
    let dir = this.tree;
    let budget = MAX_SYMLINK_DEPTH;

    while (pending.length > 0) {
      const seg = pending.shift()!;
      const child = dir.children.get(seg);
      if (!child) return null;

      if (child.kind === "symlink") {
        if (--budget < 0) {
          throw new Error(
            `ELOOP: too many levels of symbolic links, realpath '${rawPath}'`
          );
        }
        const base = resolved.length > 0 ? "/" + resolved.join("/") : "";
        const abs = child.target.startsWith("/")
          ? normalizePath(child.target)
          : normalizePath(base + "/" + child.target);
        pending.unshift(...split(abs));
        resolved.length = 0;
        dir = this.tree;
        continue;
      }

      resolved.push(seg);
      if (child.kind === "dir" && pending.length > 0) {
        dir = child;
      } else if (pending.length > 0) {
        return null;
      }
    }

    return "/" + resolved.join("/");
  }

  // ── Mutation helpers ───────────────────────────────────────────────

  private insertContent(
    rawPath: string,
    content: FileContent,
    encoding?: BufferEncoding,
    mode?: number,
    mtime?: Date
  ): void {
    validatePath(rawPath, "write");
    const segs = split(normalizePath(rawPath));
    if (segs.length === 0) {
      throw new Error(
        `EISDIR: illegal operation on a directory, write '${rawPath}'`
      );
    }
    const parent = this.scaffold(segs);
    parent.children.set(segs[segs.length - 1], {
      kind: "file",
      bytes: toBuffer(content, encoding),
      mode: mode ?? DEFAULT_FILE_MODE,
      mtime: mtime ?? new Date()
    });
  }

  private insertLazy(
    rawPath: string,
    provider: () => string | Uint8Array | Promise<string | Uint8Array>,
    mode?: number,
    mtime?: Date
  ): void {
    validatePath(rawPath, "write");
    const segs = split(normalizePath(rawPath));
    if (segs.length === 0) return;
    const parent = this.scaffold(segs);
    parent.children.set(segs[segs.length - 1], {
      kind: "lazy",
      provider,
      mode: mode ?? DEFAULT_FILE_MODE,
      mtime: mtime ?? new Date()
    });
  }

  private async forceLazy(loc: Located): Promise<Uint8Array> {
    const lazy = loc.node as VLazyNode;
    const raw = await lazy.provider();
    const bytes = typeof raw === "string" ? utf8.encode(raw) : raw;
    loc.parent.children.set(loc.key, {
      kind: "file",
      bytes,
      mode: lazy.mode,
      mtime: lazy.mtime
    });
    return bytes;
  }

  private scaffold(segs: string[]): VDirNode {
    let dir = this.tree;
    for (let i = 0; i < segs.length - 1; i++) {
      const child = dir.children.get(segs[i]);
      if (child && child.kind === "dir") {
        dir = child;
      } else {
        const d = freshDir();
        dir.children.set(segs[i], d);
        dir = d;
      }
    }
    return dir;
  }

  private placeNode(normalized: string, node: VNode): void {
    const segs = split(normalized);
    const parent = this.scaffold(segs);
    parent.children.set(segs[segs.length - 1], node);
  }

  private deepClone(node: VNode): VNode {
    switch (node.kind) {
      case "file":
        return {
          kind: "file",
          bytes: new Uint8Array(node.bytes),
          mode: node.mode,
          mtime: node.mtime
        };
      case "lazy":
        return { ...node };
      case "symlink":
        return { ...node };
      case "dir": {
        const clone: VDirNode = {
          kind: "dir",
          children: new Map(),
          mode: node.mode,
          mtime: node.mtime
        };
        for (const [k, v] of node.children) {
          clone.children.set(k, this.deepClone(v));
        }
        return clone;
      }
    }
  }

  private gather(
    dir: VDirNode,
    prefix: string,
    re: RegExp,
    out: string[]
  ): void {
    for (const [name, child] of dir.children) {
      const full = prefix + "/" + name;
      if (re.test(full)) out.push(full);
      if (child.kind === "dir") this.gather(child, full, re, out);
    }
  }

  private missing(op: string, path: string): Error {
    return new Error(`ENOENT: no such file or directory, ${op} '${path}'`);
  }
}
