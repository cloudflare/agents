import type { Workspace, FileInfo } from "../../../workspace";

/**
 * Operations interfaces — abstractions over file I/O so the same tools
 * can work against Workspace, a local filesystem, or anything else.
 */

export interface ReadOperations {
  readFile(path: string): Promise<string | null>;
  fileStat(path: string): FileInfo | null;
}

export interface WriteOperations {
  writeFile(path: string, content: string): Promise<void>;
  mkdir(path: string, opts?: { recursive?: boolean }): void;
}

export interface EditOperations {
  readFile(path: string): Promise<string | null>;
  writeFile(path: string, content: string): Promise<void>;
}

export interface ListOperations {
  listFiles(
    dir: string,
    opts?: { limit?: number; offset?: number }
  ): FileInfo[];
}

export interface FindOperations {
  glob(pattern: string): FileInfo[];
}

export interface GrepOperations {
  glob(pattern: string): FileInfo[];
  readFile(path: string): Promise<string | null>;
}

/**
 * Create default operations backed by a Workspace instance.
 */
export function workspaceReadOps(ws: Workspace): ReadOperations {
  return {
    readFile: (path) => ws.readFile(path),
    fileStat: (path) => ws.fileStat(path)
  };
}

export function workspaceWriteOps(ws: Workspace): WriteOperations {
  return {
    writeFile: (path, content) => ws.writeFile(path, content),
    mkdir: (path, opts) => ws.mkdir(path, opts)
  };
}

export function workspaceEditOps(ws: Workspace): EditOperations {
  return {
    readFile: (path) => ws.readFile(path),
    writeFile: (path, content) => ws.writeFile(path, content)
  };
}

export function workspaceListOps(ws: Workspace): ListOperations {
  return {
    listFiles: (dir, opts) => ws.listFiles(dir, opts)
  };
}

export function workspaceFindOps(ws: Workspace): FindOperations {
  return {
    glob: (pattern) => ws.glob(pattern)
  };
}

export function workspaceGrepOps(ws: Workspace): GrepOperations {
  return {
    glob: (pattern) => ws.glob(pattern),
    readFile: (path) => ws.readFile(path)
  };
}
