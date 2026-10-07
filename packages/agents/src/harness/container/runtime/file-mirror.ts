/**
 * Mirrors a CLI's state directories into the Durable Object and back.
 *
 * Agent CLIs keep their sessions as files: Claude Code under
 * `~/.claude/projects`, Codex under `~/.codex/sessions`. A container's disk
 * does not outlive the container, so the mirror ships every change to
 * those files out as persisted entries, and writes them back, in order,
 * when the session opens in a new container. The CLI then resumes its own
 * session from its own files and never knows it moved.
 *
 * Session files are append-only logs, so a file that grew ships only the
 * bytes it gained. A file that shrank, or changed without growing, ships
 * whole. Data travels base64-encoded in pieces small enough for one
 * WebSocket message.
 */

import { mkdir, open, readdir, rm, stat } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import type { JsonValue } from "../protocol";
import { isJsonObject } from "./json";

/** Most bytes of one file in one entry. */
const PIECE_BYTES = 128 * 1024;

/** Bytes of `path` from `offset` on; `offset` 0 replaces the file. */
type FileEntry = {
  readonly kind: "file";
  readonly path: string;
  readonly offset: number;
  readonly data: string;
};

type Seen = { readonly size: number; readonly mtimeMs: number };

function isFileEntry(value: JsonValue): value is FileEntry {
  return (
    isJsonObject(value) &&
    value.kind === "file" &&
    typeof value.path === "string" &&
    typeof value.offset === "number" &&
    typeof value.data === "string"
  );
}

/** One session's mirrored directories, under the session's home. */
export class FileMirror {
  readonly #root: string;
  readonly #dirs: readonly string[];
  readonly #seen = new Map<string, Seen>();

  /**
   * @param root - The session's home directory.
   * @param dirs - Directories to mirror, relative to `root`.
   */
  constructor(root: string, dirs: readonly string[]) {
    this.#root = resolve(root);
    this.#dirs = dirs;
  }

  /**
   * Replace the mirrored directories with the persisted entries, applied in
   * order. Entries that are not file entries are skipped. Whatever the
   * directories held before (a reset session's old files, say) is removed.
   *
   * @param entries - Everything persisted for the session, oldest first.
   */
  async restore(entries: readonly JsonValue[]): Promise<void> {
    for (const dir of this.#dirs) {
      const path = this.#inside(dir);
      if (path !== undefined && path !== this.#root) {
        await rm(path, { recursive: true, force: true });
      }
    }
    for (const entry of entries) {
      if (!isFileEntry(entry)) continue;
      const path = this.#inside(entry.path);
      if (path === undefined) continue;
      await mkdir(dirname(path), { recursive: true });
      const handle =
        entry.offset === 0
          ? await open(path, "w")
          : await open(path, "r+").catch(() => open(path, "w"));
      try {
        if (entry.offset > 0) await handle.truncate(entry.offset);
        await handle.write(
          Buffer.from(entry.data, "base64"),
          0,
          undefined,
          entry.offset
        );
      } finally {
        await handle.close();
      }
    }
    // What was restored is already persisted: only later changes ship.
    for (const file of await this.#files()) {
      const info = await stat(file);
      this.#seen.set(file, { size: info.size, mtimeMs: info.mtimeMs });
    }
  }

  /**
   * The changes since the last call (or the restore), as entries to persist.
   *
   * @returns File entries, in the order they must be applied.
   */
  async collect(): Promise<FileEntry[]> {
    const entries: FileEntry[] = [];
    for (const file of await this.#files()) {
      const info = await stat(file).catch(() => undefined);
      if (!info) continue;
      const seen = this.#seen.get(file);
      if (seen && seen.size === info.size && seen.mtimeMs === info.mtimeMs) {
        continue;
      }
      // Grown: ship the new bytes. New, shrunk, or rewritten: ship it whole.
      const from = seen && info.size > seen.size ? seen.size : 0;
      const bytes = await this.#read(file, from, info.size);
      const pieces: Buffer[] = [];
      for (let at = 0; at < bytes.length; at += PIECE_BYTES) {
        pieces.push(bytes.subarray(at, at + PIECE_BYTES));
      }
      if (pieces.length === 0) pieces.push(bytes);
      pieces.forEach((piece, index) => {
        entries.push(this.#entry(file, from + index * PIECE_BYTES, piece));
      });
      this.#seen.set(file, {
        size: from + bytes.length,
        mtimeMs: info.mtimeMs
      });
    }
    return entries;
  }

  #entry(file: string, offset: number, data: Buffer): FileEntry {
    return {
      kind: "file",
      path: relative(this.#root, file).split(sep).join("/"),
      offset,
      data: data.toString("base64")
    };
  }

  async #read(file: string, from: number, to: number): Promise<Buffer> {
    const handle = await open(file, "r");
    try {
      const buffer = Buffer.alloc(Math.max(0, to - from));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, from);
      return buffer.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
  }

  async #files(): Promise<string[]> {
    const files: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      const entries = await readdir(dir, { withFileTypes: true }).catch(
        () => []
      );
      for (const entry of entries) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) await walk(path);
        else if (entry.isFile()) files.push(path);
      }
    };
    for (const dir of this.#dirs) {
      const path = this.#inside(dir);
      if (path !== undefined) await walk(path);
    }
    return files.sort();
  }

  /** `path` under the root, or undefined if it would escape it. */
  #inside(path: string): string | undefined {
    const full = resolve(this.#root, path);
    return full === this.#root || full.startsWith(this.#root + sep)
      ? full
      : undefined;
  }
}
