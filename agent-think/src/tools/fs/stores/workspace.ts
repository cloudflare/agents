/**
 * `FileStore` adapter over `@cloudflare/workspace`'s `Workspace.fs`
 * surface. Hackspace's fs-tools assumed a flat `stat / readFile /
 * writeFile` shape; the next-branch `Workspace` nests them under
 * `.fs` and returns a different stat result. This adapter is the
 * only place that knows.
 *
 * Reads go through `fs.readFile(path, "utf8" | ReadFileOptions)` —
 * for binary we ask for a `ReadableStream<Uint8Array>` and stitch it
 * back together either chunk-by-chunk (`readChunks`) or all at once
 * (`readAll`).
 */

import type { FileStat, FileStore } from "./types";

/**
 * Structural subset of `@cloudflare/workspace.Workspace` we depend
 * on. Avoids a hard type-time import so this module can be vendored
 * around the example with no fuss.
 */
export interface WorkspaceLike {
  fs: {
    stat(path: string): Promise<{
      size: number;
      mtime: number;
      mode: number;
      isFile: boolean;
      isDirectory: boolean;
    }>;
    readFile(path: string): Promise<ReadableStream<Uint8Array>>;
    readFile(
      path: string,
      options: { offset?: number; length?: number }
    ): Promise<ReadableStream<Uint8Array>>;
    writeFile(
      path: string,
      content: Uint8Array,
      options?: { mode?: number }
    ): Promise<void>;
    mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
    rm(
      path: string,
      options?: { recursive?: boolean; force?: boolean }
    ): Promise<void>;
    readdir(
      path: string
    ): Promise<Array<{ name: string; isFile: boolean; isDirectory: boolean }>>;
  };
}

export class WorkspaceFileStore implements FileStore {
  constructor(private readonly ws: WorkspaceLike) {}

  async stat(path: string): Promise<FileStat | null> {
    try {
      const s = await this.ws.fs.stat(path);
      if (!s.isFile) return null;
      return { size: s.size, mtime: s.mtime, mode: s.mode };
    } catch (err) {
      if (isEnoent(err)) return null;
      throw err;
    }
  }

  async readAll(path: string): Promise<Uint8Array | null> {
    try {
      const stream = await this.ws.fs.readFile(path);
      return await drain(stream);
    } catch (err) {
      if (isEnoent(err)) return null;
      throw err;
    }
  }

  async write(
    path: string,
    content: Uint8Array,
    opts?: { mode?: number }
  ): Promise<void> {
    await ensureParentDir(this.ws, path);
    await this.ws.fs.writeFile(path, content, opts);
  }

  async *readChunks(
    path: string,
    byteOffset = 0,
    byteLength?: number
  ): AsyncIterable<Uint8Array> {
    // The Workspace readFile already returns a chunked stream; we just
    // re-yield with the requested offset/length applied at the source.
    const options: { offset?: number; length?: number } = {};
    if (byteOffset > 0) options.offset = byteOffset;
    if (byteLength !== undefined) options.length = byteLength;
    const stream = await this.ws.fs.readFile(path, options);
    const reader = stream.getReader();
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value && value.byteLength > 0) yield value;
      }
    } finally {
      reader.releaseLock();
    }
  }
}

async function drain(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) {
        parts.push(value);
        total += value.byteLength;
      }
    }
  } finally {
    reader.releaseLock();
  }
  if (parts.length === 1) return parts[0];
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.byteLength;
  }
  return out;
}

async function ensureParentDir(ws: WorkspaceLike, path: string): Promise<void> {
  const i = path.lastIndexOf("/");
  if (i <= 0) return;
  const parent = path.slice(0, i);
  await ws.fs.mkdir(parent, { recursive: true });
}

function isEnoent(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { code?: string; message?: string };
  if (e.code === "ENOENT") return true;
  return typeof e.message === "string" && /ENOENT|no such/i.test(e.message);
}
