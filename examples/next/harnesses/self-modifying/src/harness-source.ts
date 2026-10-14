import type { Workspace } from "@cloudflare/computer";

const HARNESS_ROOT = "/harness/";
const MAX_SOURCE_FILES = 256;
const MAX_SOURCE_FILE_BYTES = 1_000_000;
const MAX_SOURCE_BYTES = 4_000_000;

/** A source path outside the editable `/harness` tree. */
export class HarnessPathError extends Error {
  readonly _tag = "HarnessPathError" as const;
}

function absoluteHarnessPath(path: string): string {
  const absolute = path.startsWith("/") ? path : `${HARNESS_ROOT}${path}`;
  if (
    !absolute.startsWith(HARNESS_ROOT) ||
    absolute.includes("/../") ||
    absolute.endsWith("/..")
  ) {
    throw new HarnessPathError(
      `Harness source path must remain under ${HARNESS_ROOT}: ${JSON.stringify(path)}`
    );
  }
  if (absolute === HARNESS_ROOT) {
    throw new HarnessPathError("Harness source path must name a file");
  }
  return absolute;
}

function fileBytes(content: string): number {
  return new TextEncoder().encode(content).byteLength;
}

function requireFileSize(path: string, content: string): number {
  const bytes = fileBytes(content);
  if (bytes > MAX_SOURCE_FILE_BYTES) {
    throw new HarnessPathError(
      `Harness source file ${JSON.stringify(path)} exceeds ${MAX_SOURCE_FILE_BYTES} bytes`
    );
  }
  return bytes;
}

/** The part of a `@cloudflare/computer` Workspace the source tree uses. */
export type HarnessWorkspace = Pick<Workspace, "fs">;

function isNotFound(error: unknown): boolean {
  return (error as { code?: unknown }).code === "ENOENT";
}

/** Durable editable source tree stored in a Computer Workspace. */
export class HarnessSource {
  readonly #workspace: HarnessWorkspace;

  /** Bind source operations to the host's durable Workspace. */
  constructor(workspace: HarnessWorkspace) {
    this.#workspace = workspace;
  }

  /** Absolute paths of every file under `/harness`. */
  async #files(): Promise<string[]> {
    try {
      const entries = await this.#workspace.fs.find(
        HARNESS_ROOT.slice(0, -1),
        "**"
      );
      return entries
        .filter((entry) => entry.type === "file")
        .map((entry) => entry.path);
    } catch (error) {
      if (isNotFound(error)) return [];
      throw error;
    }
  }

  async #readFile(path: string): Promise<string | null> {
    try {
      return await this.#workspace.fs.readFile(path, "utf8");
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async #writeFile(path: string, content: string): Promise<void> {
    await this.#workspace.fs.mkdir(path.slice(0, path.lastIndexOf("/")), {
      recursive: true
    });
    await this.#workspace.fs.writeFile(path, content);
  }

  /** Seed a new object without overwriting an existing working tree. */
  async seed(files: Readonly<Record<string, string>>): Promise<boolean> {
    if ((await this.#files()).length > 0) return false;
    this.#requireSnapshotSize(files);
    for (const [path, content] of Object.entries(files)) {
      await this.#writeFile(absoluteHarnessPath(path), content);
    }
    return true;
  }

  /** Snapshot every editable source file for bundling and revision history. */
  async snapshot(): Promise<Readonly<Record<string, string>>> {
    const source: Record<string, string> = {};
    for (const path of await this.#files()) {
      const content = await this.#readFile(path);
      if (content !== null) source[path.slice(HARNESS_ROOT.length)] = content;
    }
    this.#requireSnapshotSize(source);
    return source;
  }

  /** Read one editable source file. */
  read(path: string): Promise<string | null> {
    return this.#readFile(absoluteHarnessPath(path));
  }

  /** Write one editable source file. */
  write(path: string, content: string): Promise<void> {
    requireFileSize(path, content);
    return this.#writeFile(absoluteHarnessPath(path), content);
  }

  /** Delete one editable source file. */
  async delete(path: string): Promise<boolean> {
    try {
      await this.#workspace.fs.rm(absoluteHarnessPath(path));
      return true;
    } catch (error) {
      if (isNotFound(error)) return false;
      throw error;
    }
  }

  /** List editable source files with paths relative to `/harness`. */
  async list(): Promise<
    Array<{
      readonly path: string;
      readonly size: number;
      readonly updatedAt: number;
    }>
  > {
    const entries = await Promise.all(
      (await this.#files()).map(async (path) => {
        const stat = await this.#workspace.fs.stat(path);
        return {
          path: path.slice(HARNESS_ROOT.length),
          size: stat.size,
          updatedAt: stat.mtime
        };
      })
    );
    return entries.sort((left, right) => left.path.localeCompare(right.path));
  }

  /** Replace the working tree with an activated source snapshot. */
  async replace(source: Readonly<Record<string, string>>): Promise<void> {
    this.#requireSnapshotSize(source);
    for (const path of await this.#files()) {
      await this.#workspace.fs.rm(path);
    }
    for (const [path, content] of Object.entries(source)) {
      await this.#writeFile(absoluteHarnessPath(path), content);
    }
  }

  #requireSnapshotSize(source: Readonly<Record<string, string>>): void {
    const entries = Object.entries(source);
    if (entries.length > MAX_SOURCE_FILES) {
      throw new HarnessPathError(
        `Harness source has ${entries.length} files; maximum is ${MAX_SOURCE_FILES}`
      );
    }
    let total = 0;
    for (const [path, content] of entries) {
      absoluteHarnessPath(path);
      total += requireFileSize(path, content);
      if (total > MAX_SOURCE_BYTES) {
        throw new HarnessPathError(
          `Harness source exceeds ${MAX_SOURCE_BYTES} total bytes`
        );
      }
    }
  }
}
