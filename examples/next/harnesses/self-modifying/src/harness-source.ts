import type { Workspace } from "@cloudflare/shell";

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

/** Durable editable source tree stored in a Shell Workspace. */
export class HarnessSource {
  readonly #workspace: Workspace;

  /** Bind source operations to the host's durable Workspace. */
  constructor(workspace: Workspace) {
    this.#workspace = workspace;
  }

  /** Seed a new object without overwriting an existing working tree. */
  async seed(files: Readonly<Record<string, string>>): Promise<boolean> {
    const existing = await this.#workspace.glob(`${HARNESS_ROOT}**`);
    if (existing.some((entry) => entry.type === "file")) return false;
    this.#requireSnapshotSize(files);
    for (const [path, content] of Object.entries(files)) {
      await this.#workspace.writeFile(absoluteHarnessPath(path), content);
    }
    return true;
  }

  /** Snapshot every editable source file for bundling and revision history. */
  async snapshot(): Promise<Readonly<Record<string, string>>> {
    const entries = await this.#workspace.glob(`${HARNESS_ROOT}**`);
    const source: Record<string, string> = {};
    for (const entry of entries) {
      if (entry.type !== "file") continue;
      const content = await this.#workspace.readFile(entry.path);
      if (content !== null)
        source[entry.path.slice(HARNESS_ROOT.length)] = content;
    }
    this.#requireSnapshotSize(source);
    return source;
  }

  /** Read one editable source file. */
  read(path: string): Promise<string | null> {
    return this.#workspace.readFile(absoluteHarnessPath(path));
  }

  /** Write one editable source file. */
  write(path: string, content: string): Promise<void> {
    requireFileSize(path, content);
    return this.#workspace.writeFile(absoluteHarnessPath(path), content);
  }

  /** Delete one editable source file. */
  delete(path: string): Promise<boolean> {
    return this.#workspace.deleteFile(absoluteHarnessPath(path));
  }

  /** List editable source files with paths relative to `/harness`. */
  async list(): Promise<
    Array<{
      readonly path: string;
      readonly size: number;
      readonly updatedAt: number;
    }>
  > {
    const entries = await this.#workspace.glob(`${HARNESS_ROOT}**`);
    return entries
      .filter((entry) => entry.type === "file")
      .map((entry) => ({
        path: entry.path.slice(HARNESS_ROOT.length),
        size: entry.size,
        updatedAt: entry.updatedAt
      }))
      .sort((left, right) => left.path.localeCompare(right.path));
  }

  /** Replace the working tree with an activated source snapshot. */
  async replace(source: Readonly<Record<string, string>>): Promise<void> {
    this.#requireSnapshotSize(source);
    const existing = await this.#workspace.glob(`${HARNESS_ROOT}**`);
    for (const entry of existing) {
      if (entry.type === "file") await this.#workspace.deleteFile(entry.path);
    }
    for (const [path, content] of Object.entries(source)) {
      await this.#workspace.writeFile(absoluteHarnessPath(path), content);
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
