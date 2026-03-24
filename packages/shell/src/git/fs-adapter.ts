/**
 * Adapter that makes a shell FileSystem compatible with isomorphic-git's
 * fs.promises interface.
 *
 * isomorphic-git expects Node-style stat objects with isFile(), isDirectory(),
 * isSymbolicLink() methods, and readFile that dispatches on encoding option.
 */

import type { FileSystem } from "../fs/interface";

/** Stat object matching Node's fs.Stats shape that isomorphic-git expects. */
class GitStat {
  type: "file" | "directory" | "symlink";
  size: number;
  mtime: Date;
  mtimeMs: number;
  ctimeMs: number;
  mode: number;
  ino: number;
  uid: number;
  gid: number;
  dev: number;

  constructor(stat: {
    type: string;
    size: number;
    mtime: Date;
    mode?: number;
  }) {
    this.type = stat.type as "file" | "directory" | "symlink";
    this.size = stat.size;
    this.mtime = stat.mtime;
    this.mtimeMs = stat.mtime.getTime();
    this.ctimeMs = this.mtimeMs;
    this.ino = 0;
    this.uid = 0;
    this.gid = 0;
    this.dev = 0;
    // Default modes: dir=0o40755, file=0o100644, symlink=0o120000
    this.mode =
      stat.mode ??
      (this.type === "directory"
        ? 0o40755
        : this.type === "symlink"
          ? 0o120000
          : 0o100644);
  }

  isFile() {
    return this.type === "file";
  }
  isDirectory() {
    return this.type === "directory";
  }
  isSymbolicLink() {
    return this.type === "symlink";
  }
}

/** Create an Error with code='ENOENT' that isomorphic-git recognizes. */
function enoent(path: string, cause?: unknown): Error & { code: string } {
  const msg = cause instanceof Error ? cause.message : `ENOENT: ${path}`;
  const err = new Error(msg) as Error & { code: string };
  err.code = "ENOENT";
  return err;
}

/**
 * Create an isomorphic-git compatible fs object from a shell FileSystem.
 *
 * Returns `{ promises: { ... } }` which isomorphic-git auto-detects.
 */
export function createGitFs(fs: FileSystem) {
  return {
    promises: {
      async readFile(
        path: string,
        options?: { encoding?: string } | string
      ): Promise<Uint8Array | string> {
        const encoding =
          typeof options === "string" ? options : options?.encoding;
        try {
          if (encoding === "utf8" || encoding === "utf-8") {
            return await fs.readFile(path);
          }
          return await fs.readFileBytes(path);
        } catch (err) {
          throw enoent(path, err);
        }
      },

      async writeFile(path: string, data: string | Uint8Array): Promise<void> {
        // Ensure parent directory exists
        const parent = path.replace(/\/[^/]+$/, "");
        if (parent && parent !== "/" && parent !== path) {
          try {
            await fs.mkdir(parent, { recursive: true });
          } catch {
            // already exists
          }
        }
        if (typeof data === "string") {
          await fs.writeFile(path, data);
        } else {
          await fs.writeFileBytes(path, data);
        }
      },

      async unlink(path: string): Promise<void> {
        await fs.rm(path);
      },

      async readdir(path: string): Promise<string[]> {
        return fs.readdir(path);
      },

      async mkdir(
        path: string,
        mode?: number | { recursive?: boolean }
      ): Promise<void> {
        const recursive = typeof mode === "object" ? mode.recursive : false;
        await fs.mkdir(path, { recursive });
      },

      async rmdir(path: string): Promise<void> {
        await fs.rm(path);
      },

      async stat(path: string): Promise<GitStat> {
        try {
          const s = await fs.stat(path);
          return new GitStat(s);
        } catch (err) {
          // isomorphic-git checks err.code === 'ENOENT'
          throw enoent(path, err);
        }
      },

      async lstat(path: string): Promise<GitStat> {
        try {
          const s = await fs.lstat(path);
          return new GitStat(s);
        } catch (err) {
          throw enoent(path, err);
        }
      },

      async readlink(path: string): Promise<string> {
        try {
          return await fs.readlink(path);
        } catch (err) {
          throw enoent(path, err);
        }
      },

      async symlink(target: string, path: string): Promise<void> {
        await fs.symlink(target, path);
      },

      async chmod(_path: string, _mode: number): Promise<void> {
        // isomorphic-git currently doesn't use chmod, but the interface
        // requires it. No-op since our fs doesn't track permissions.
      }
    }
  };
}
