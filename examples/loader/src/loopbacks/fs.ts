import { WorkerEntrypoint } from "cloudflare:workers";

/**
 * Props passed to the FSLoopback via ctx.exports
 */
export interface FSLoopbackProps {
  sessionId: string;
}

/**
 * File metadata
 */
export interface FileStat {
  path: string;
  isFile: boolean;
  isDirectory: boolean;
  size: number;
  modifiedAt: number;
}

/**
 * FSLoopback - Provides file system operations to dynamic workers
 *
 * This provides a simple file system interface that stores files in memory.
 * It's designed for temporary files and operations during code execution.
 *
 * Note: For persistent source code, use the Yjs storage (available via
 * the Agent's file endpoints). This FS is for scratch space, temp files,
 * and operations that don't need to persist or sync.
 *
 * Usage from dynamic worker:
 *   await env.FS.writeFile("/src/main.ts", "console.log('hello')");
 *   const content = await env.FS.readFile("/src/main.ts");
 */
export class FSLoopback extends WorkerEntrypoint<Env, FSLoopbackProps> {
  // In-memory file storage (scratch space, not persisted)
  private static files: Map<string, { content: string; modifiedAt: number }> =
    new Map();
  private static directories: Set<string> = new Set([
    "/",
    "/home",
    "/home/user",
    "/src"
  ]);

  /**
   * Read a file
   *
   * @param path - Absolute path to the file
   * @returns File content
   * @throws Error if file not found
   */
  async readFile(path: string): Promise<string> {
    const normalized = this.normalizePath(path);
    const file = FSLoopback.files.get(normalized);
    if (!file) {
      throw new Error(`ENOENT: no such file or directory, open '${path}'`);
    }
    return file.content;
  }

  /**
   * Write a file (creates parent directories if needed)
   *
   * @param path - Absolute path to the file
   * @param content - File content
   */
  async writeFile(path: string, content: string): Promise<void> {
    const normalized = this.normalizePath(path);

    // Ensure parent directories exist
    const parts = normalized.split("/").filter(Boolean);
    let current = "";
    for (let i = 0; i < parts.length - 1; i++) {
      current += `/${parts[i]}`;
      FSLoopback.directories.add(current);
    }

    FSLoopback.files.set(normalized, {
      content,
      modifiedAt: Date.now()
    });
  }

  /**
   * Append to a file (creates if not exists)
   *
   * @param path - Absolute path to the file
   * @param content - Content to append
   */
  async appendFile(path: string, content: string): Promise<void> {
    const normalized = this.normalizePath(path);
    const existing = FSLoopback.files.get(normalized);
    const newContent = existing ? existing.content + content : content;
    await this.writeFile(path, newContent);
  }

  /**
   * Delete a file
   *
   * @param path - Absolute path to the file
   */
  async unlink(path: string): Promise<void> {
    const normalized = this.normalizePath(path);
    if (!FSLoopback.files.has(normalized)) {
      throw new Error(`ENOENT: no such file or directory, unlink '${path}'`);
    }
    FSLoopback.files.delete(normalized);
  }

  /**
   * Check if a file or directory exists
   *
   * @param path - Path to check
   */
  async exists(path: string): Promise<boolean> {
    const normalized = this.normalizePath(path);
    return (
      FSLoopback.files.has(normalized) || FSLoopback.directories.has(normalized)
    );
  }

  /**
   * Get file/directory stats
   *
   * @param path - Path to stat
   */
  async stat(path: string): Promise<FileStat> {
    const normalized = this.normalizePath(path);

    if (FSLoopback.directories.has(normalized)) {
      return {
        path: normalized,
        isFile: false,
        isDirectory: true,
        size: 0,
        modifiedAt: Date.now()
      };
    }

    const file = FSLoopback.files.get(normalized);
    if (!file) {
      throw new Error(`ENOENT: no such file or directory, stat '${path}'`);
    }

    return {
      path: normalized,
      isFile: true,
      isDirectory: false,
      size: file.content.length,
      modifiedAt: file.modifiedAt
    };
  }

  /**
   * Create a directory
   *
   * @param path - Directory path
   * @param options - Options (recursive: create parent dirs)
   */
  async mkdir(path: string, options?: { recursive?: boolean }): Promise<void> {
    const normalized = this.normalizePath(path);

    if (options?.recursive) {
      const parts = normalized.split("/").filter(Boolean);
      let current = "";
      for (const part of parts) {
        current += `/${part}`;
        FSLoopback.directories.add(current);
      }
    } else {
      // Check parent exists
      const parent =
        normalized.substring(0, normalized.lastIndexOf("/")) || "/";
      if (!FSLoopback.directories.has(parent)) {
        throw new Error(`ENOENT: no such file or directory, mkdir '${path}'`);
      }
      FSLoopback.directories.add(normalized);
    }
  }

  /**
   * Read a directory
   *
   * @param path - Directory path
   * @returns Array of entry names
   */
  async readdir(path: string): Promise<string[]> {
    const normalized = this.normalizePath(path);

    if (!FSLoopback.directories.has(normalized)) {
      throw new Error(`ENOENT: no such file or directory, scandir '${path}'`);
    }

    const entries = new Set<string>();
    const prefix = normalized === "/" ? "/" : `${normalized}/`;

    // Find files in this directory
    for (const filePath of FSLoopback.files.keys()) {
      if (filePath.startsWith(prefix)) {
        const rest = filePath.substring(prefix.length);
        const name = rest.split("/")[0];
        if (name) entries.add(name);
      }
    }

    // Find subdirectories
    for (const dirPath of FSLoopback.directories) {
      if (dirPath.startsWith(prefix) && dirPath !== normalized) {
        const rest = dirPath.substring(prefix.length);
        const name = rest.split("/")[0];
        if (name) entries.add(name);
      }
    }

    return Array.from(entries).sort();
  }

  /**
   * Remove a directory
   *
   * @param path - Directory path
   * @param options - Options (recursive: remove contents)
   */
  async rmdir(path: string, options?: { recursive?: boolean }): Promise<void> {
    const normalized = this.normalizePath(path);

    if (!FSLoopback.directories.has(normalized)) {
      throw new Error(`ENOENT: no such file or directory, rmdir '${path}'`);
    }

    const prefix = `${normalized}/`;

    if (options?.recursive) {
      // Remove all files and subdirs
      for (const filePath of FSLoopback.files.keys()) {
        if (filePath.startsWith(prefix)) {
          FSLoopback.files.delete(filePath);
        }
      }
      for (const dirPath of FSLoopback.directories) {
        if (dirPath.startsWith(prefix)) {
          FSLoopback.directories.delete(dirPath);
        }
      }
    } else {
      // Check if empty
      for (const filePath of FSLoopback.files.keys()) {
        if (filePath.startsWith(prefix)) {
          throw new Error(`ENOTEMPTY: directory not empty, rmdir '${path}'`);
        }
      }
      for (const dirPath of FSLoopback.directories) {
        if (dirPath.startsWith(prefix)) {
          throw new Error(`ENOTEMPTY: directory not empty, rmdir '${path}'`);
        }
      }
    }

    FSLoopback.directories.delete(normalized);
  }

  /**
   * Normalize a path (resolve . and .., ensure leading /)
   */
  private normalizePath(inputPath: string): string {
    // Ensure absolute path
    const path = inputPath.startsWith("/")
      ? inputPath
      : `/home/user/${inputPath}`;

    // Resolve . and ..
    const parts = path.split("/");
    const resolved: string[] = [];

    for (const part of parts) {
      if (part === "" || part === ".") continue;
      if (part === "..") {
        resolved.pop();
      } else {
        resolved.push(part);
      }
    }

    return `/${resolved.join("/")}`;
  }
}
