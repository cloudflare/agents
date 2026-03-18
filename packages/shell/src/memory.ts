import { InMemoryFs } from "./fs/in-memory-fs";
import type {
  CpOptions,
  FileSystem,
  FsStat,
  InitialFiles,
  MkdirOptions,
  RmOptions
} from "./fs/interface";
import type {
  StateArchiveCreateResult,
  StateArchiveExtractResult,
  StateArchiveEntry,
  StateApplyEditsOptions,
  StateApplyEditsResult,
  StateBackend,
  StateCapabilities,
  StateCopyOptions,
  StateDirent,
  StateEdit,
  StateEditInstruction,
  StateEditPlan,
  StateFileDetection,
  StateFileSearchResult,
  StateFindEntry,
  StateFindOptions,
  StateHashOptions,
  StateJsonUpdateOperation,
  StateJsonUpdateResult,
  StateJsonWriteOptions,
  StateMkdirOptions,
  StateMoveOptions,
  StateCompressionResult,
  StateReplaceInFilesOptions,
  StateReplaceInFilesResult,
  StateReplaceResult,
  StateRmOptions,
  StateSearchOptions,
  StateStat,
  StateTreeNode,
  StateTreeOptions,
  StateTreeSummary
} from "./backend";
import {
  buildTar,
  buildTree,
  detectFile as detectFileFromBytes,
  extractTar,
  findInTree,
  gzipBytes,
  gunzipBytes,
  hashBytes,
  listTar,
  queryJsonValue,
  summarizeTree,
  updateJsonValue,
  type TarInputEntry
} from "./extras";
import {
  applyTextEdits,
  collectFileReplaceResults,
  collectFileSearchResults,
  diffContent,
  parseJsonFileContent,
  planTextEdits,
  planToStateEdits,
  replaceTextContent,
  searchTextContent,
  stateDirent,
  stringifyJsonFileContent,
  toStateStat
} from "./helpers";

// ── FileSystemStateBackend ────────────────────────────────────────────
//
// The single StateBackend implementation. Accepts any FileSystem —
// pass `new InMemoryFs()` for ephemeral in-memory state or a
// `WorkspaceFileSystem` wrapping a durable Workspace.

export interface FileSystemStateBackendOptions {
  files?: InitialFiles;
  fs?: FileSystem;
}

export class FileSystemStateBackend implements StateBackend {
  readonly fs: FileSystem;

  constructor(fsOrOptions: FileSystem | FileSystemStateBackendOptions = {}) {
    if (isFileSystem(fsOrOptions)) {
      this.fs = fsOrOptions;
    } else {
      this.fs = fsOrOptions.fs ?? new InMemoryFs(fsOrOptions.files);
    }
  }

  async getCapabilities(): Promise<StateCapabilities> {
    return {
      chmod: true,
      utimes: true,
      hardLinks: true
    };
  }

  async readFile(path: string): Promise<string> {
    return this.fs.readFile(path);
  }

  async readFileBytes(path: string): Promise<Uint8Array> {
    return this.fs.readFileBytes(path);
  }

  async writeFile(path: string, content: string): Promise<void> {
    await this.fs.writeFile(path, content);
  }

  async writeFileBytes(path: string, content: Uint8Array): Promise<void> {
    await this.fs.writeFileBytes(path, content);
  }

  async appendFile(path: string, content: string | Uint8Array): Promise<void> {
    await this.fs.appendFile(path, content);
  }

  async readJson(path: string): Promise<unknown> {
    return parseJsonFileContent(await this.readFile(path), path);
  }

  async writeJson(
    path: string,
    value: unknown,
    options?: StateJsonWriteOptions
  ): Promise<void> {
    await this.writeFile(
      path,
      stringifyJsonFileContent(value, path, options?.spaces)
    );
  }

  async queryJson(path: string, query: string): Promise<unknown> {
    return queryJsonValue(await this.readJson(path), query);
  }

  async updateJson(
    path: string,
    operations: StateJsonUpdateOperation[]
  ): Promise<StateJsonUpdateResult> {
    const current = await this.readJson(path);
    const updated = updateJsonValue(current, operations, path);
    await this.writeFile(path, updated.content);
    return updated;
  }

  async exists(path: string): Promise<boolean> {
    return this.fs.exists(path);
  }

  async stat(path: string): Promise<StateStat | null> {
    return this.tryStat(() => this.fs.stat(path));
  }

  async lstat(path: string): Promise<StateStat | null> {
    return this.tryStat(() => this.fs.lstat(path));
  }

  async mkdir(path: string, options?: StateMkdirOptions): Promise<void> {
    await this.fs.mkdir(path, options as MkdirOptions | undefined);
  }

  async readdir(path: string): Promise<string[]> {
    return this.fs.readdir(path);
  }

  async readdirWithFileTypes(path: string): Promise<StateDirent[]> {
    const entries = await this.fs.readdirWithFileTypes(path);
    return sortDirents(entries.map((e) => stateDirent(e.name, e.type)));
  }

  async find(
    path: string,
    options?: StateFindOptions
  ): Promise<StateFindEntry[]> {
    return findInTree(path, this.createTreeOps(), options);
  }

  async walkTree(
    path: string,
    options?: StateTreeOptions
  ): Promise<StateTreeNode> {
    return buildTree(path, this.createTreeOps(), options);
  }

  async summarizeTree(
    path: string,
    options?: StateTreeOptions
  ): Promise<StateTreeSummary> {
    return summarizeTree(path, this.createTreeOps(), options);
  }

  async searchText(
    path: string,
    query: string,
    options?: StateSearchOptions
  ): Promise<ReturnType<typeof searchTextContent>> {
    return searchTextContent(await this.readFile(path), query, options);
  }

  async searchFiles(
    pattern: string,
    query: string,
    options?: StateSearchOptions
  ): Promise<StateFileSearchResult[]> {
    const paths = await this.getFilePaths(pattern);
    return collectFileSearchResults(
      paths,
      this.readFile.bind(this),
      (content) => searchTextContent(content, query, options)
    );
  }

  async replaceInFile(
    path: string,
    search: string,
    replacement: string,
    options?: StateSearchOptions
  ): Promise<StateReplaceResult> {
    const current = await this.readFile(path);
    const result = replaceTextContent(current, search, replacement, options);
    if (result.replaced > 0) {
      await this.writeFile(path, result.content);
    }
    return result;
  }

  async replaceInFiles(
    pattern: string,
    search: string,
    replacement: string,
    options?: StateReplaceInFilesOptions
  ): Promise<StateReplaceInFilesResult> {
    const paths = await this.getFilePaths(pattern);
    return collectFileReplaceResults(
      paths,
      this.readFile.bind(this),
      this.writeFile.bind(this),
      this.deleteFile.bind(this),
      search,
      replacement,
      options
    );
  }

  async rm(path: string, options?: StateRmOptions): Promise<void> {
    await this.fs.rm(path, options as RmOptions | undefined);
  }

  async cp(
    src: string,
    dest: string,
    options?: StateCopyOptions
  ): Promise<void> {
    await this.fs.cp(src, dest, options as CpOptions | undefined);
  }

  async mv(
    src: string,
    dest: string,
    options?: StateMoveOptions
  ): Promise<void> {
    const stat = await this.stat(src);
    if (stat?.type === "directory" && !options?.recursive) {
      throw new Error(
        `EISDIR: cannot move directory without recursive: ${src}`
      );
    }
    await this.fs.mv(src, dest);
  }

  async symlink(target: string, linkPath: string): Promise<void> {
    await this.fs.symlink(target, linkPath);
  }

  async readlink(path: string): Promise<string> {
    return this.fs.readlink(path);
  }

  async realpath(path: string): Promise<string> {
    return this.fs.realpath(path);
  }

  async resolvePath(base: string, path: string): Promise<string> {
    return this.fs.resolvePath(base, path);
  }

  async glob(pattern: string): Promise<string[]> {
    return this.fs.glob(pattern);
  }

  async diff(pathA: string, pathB: string): Promise<string> {
    const [before, after] = await Promise.all([
      this.readFile(pathA),
      this.readFile(pathB)
    ]);
    return diffContent(before, after, pathA, pathB);
  }

  async diffContent(path: string, newContent: string): Promise<string> {
    return diffContent(await this.readFile(path), newContent, path, path);
  }

  async createArchive(
    path: string,
    sources: string[]
  ): Promise<StateArchiveCreateResult> {
    const entries = await this.collectArchiveEntries(sources);
    const tar = buildTar(entries);
    await this.writeFileBytes(path, tar);
    return {
      path,
      entries: entries.map((entry) => ({
        path: entry.path,
        type: entry.type,
        size: entry.type === "file" ? entry.bytes.byteLength : 0
      })),
      bytesWritten: tar.byteLength
    };
  }

  async listArchive(path: string): Promise<StateArchiveEntry[]> {
    return listTar(await this.readFileBytes(path));
  }

  async extractArchive(
    path: string,
    destination: string
  ): Promise<StateArchiveExtractResult> {
    const entries = extractTar(await this.readFileBytes(path));
    for (const entry of entries) {
      const destPath =
        destination === "/" ? `/${entry.path}` : `${destination}/${entry.path}`;
      if (entry.type === "directory") {
        await this.mkdir(destPath, { recursive: true });
      } else if (entry.bytes) {
        await this.writeFileBytes(destPath, entry.bytes);
      }
    }
    return {
      destination,
      entries: entries.map((entry) => ({
        path: entry.path,
        type: entry.type,
        size: entry.bytes?.byteLength ?? 0
      }))
    };
  }

  async compressFile(
    path: string,
    destination?: string
  ): Promise<StateCompressionResult> {
    const dest = destination ?? `${path}.gz`;
    const bytes = await gzipBytes(await this.readFileBytes(path));
    await this.writeFileBytes(dest, bytes);
    return { path, destination: dest, bytesWritten: bytes.byteLength };
  }

  async decompressFile(
    path: string,
    destination?: string
  ): Promise<StateCompressionResult> {
    const dest = destination ?? path.replace(/\.gz$/i, "");
    const bytes = await gunzipBytes(await this.readFileBytes(path));
    await this.writeFileBytes(dest, bytes);
    return { path, destination: dest, bytesWritten: bytes.byteLength };
  }

  async hashFile(path: string, options?: StateHashOptions): Promise<string> {
    return hashBytes(await this.readFileBytes(path), options);
  }

  async detectFile(path: string): Promise<StateFileDetection> {
    return detectFileFromBytes(path, await this.readFileBytes(path));
  }

  async removeTree(path: string): Promise<void> {
    await this.fs.rm(path, { recursive: true, force: true });
  }

  async copyTree(src: string, dest: string): Promise<void> {
    await this.fs.cp(src, dest, { recursive: true });
  }

  async moveTree(src: string, dest: string): Promise<void> {
    await this.fs.mv(src, dest);
  }

  async planEdits(
    instructions: StateEditInstruction[]
  ): Promise<StateEditPlan> {
    return planTextEdits(instructions, async (path) => {
      try {
        return await this.readFile(path);
      } catch (error) {
        if (isEnoent(error)) return null;
        throw error;
      }
    });
  }

  async applyEditPlan(
    plan: StateEditPlan,
    options?: StateApplyEditsOptions
  ): Promise<StateApplyEditsResult> {
    return this.applyEdits(planToStateEdits(plan), options);
  }

  async applyEdits(
    edits: StateEdit[],
    options?: StateApplyEditsOptions
  ): Promise<StateApplyEditsResult> {
    return applyTextEdits(
      edits,
      async (path) => {
        try {
          return await this.readFile(path);
        } catch (error) {
          if (isEnoent(error)) return null;
          throw error;
        }
      },
      this.writeFile.bind(this),
      this.deleteFile.bind(this),
      options
    );
  }

  // ── Private helpers ───────────────────────────────────────────────

  private async tryStat(
    getStat: () => Promise<FsStat>
  ): Promise<StateStat | null> {
    try {
      return toStateStat(await getStat());
    } catch (error) {
      if (isEnoent(error)) return null;
      throw error;
    }
  }

  private async getFilePaths(pattern: string): Promise<string[]> {
    const paths = await this.glob(pattern);
    const files: string[] = [];
    for (const path of paths) {
      const stat = await this.lstat(path);
      if (stat?.type === "file") {
        files.push(path);
      }
    }
    return files;
  }

  private async deleteFile(path: string): Promise<void> {
    await this.fs.rm(path, { force: true });
  }

  private createTreeOps() {
    return {
      lstat: this.lstat.bind(this),
      readdirWithFileTypes: this.readdirWithFileTypes.bind(this),
      resolvePath: this.resolvePath.bind(this)
    };
  }

  private async collectArchiveEntries(
    sources: string[]
  ): Promise<TarInputEntry[]> {
    const entries: TarInputEntry[] = [];
    for (const source of sources) {
      const tree = await this.walkTree(source);
      await appendArchiveNode(tree, entries, this.readFileBytes.bind(this));
    }
    return entries;
  }
}

// ── Factory helpers ───────────────────────────────────────────────────

/** @deprecated Use `new FileSystemStateBackend()` or `createMemoryStateBackend()` */
export type MemoryStateBackendOptions = FileSystemStateBackendOptions;

/** @deprecated Use `FileSystemStateBackend` */
export const MemoryStateBackend = FileSystemStateBackend;

export function createMemoryStateBackend(
  options: FileSystemStateBackendOptions = {}
): FileSystemStateBackend {
  return new FileSystemStateBackend(options);
}

// ── Utilities ─────────────────────────────────────────────────────────

function isFileSystem(value: unknown): value is FileSystem {
  return (
    typeof value === "object" &&
    value !== null &&
    "readFile" in value &&
    "writeFile" in value &&
    "glob" in value
  );
}

function isEnoent(error: unknown): boolean {
  return error instanceof Error && error.message.includes("ENOENT");
}

function sortDirents(entries: StateDirent[]): StateDirent[] {
  return [...entries].sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0
  );
}

async function appendArchiveNode(
  node: StateTreeNode,
  entries: TarInputEntry[],
  readFileBytes: (path: string) => Promise<Uint8Array>
): Promise<void> {
  const relativePath = node.path.replace(/^\/+/, "");
  if (node.type === "directory") {
    entries.push({ path: relativePath || ".", type: "directory" });
    for (const child of node.children ?? []) {
      await appendArchiveNode(child, entries, readFileBytes);
    }
    return;
  }
  if (node.type === "file") {
    entries.push({
      path: relativePath,
      type: "file",
      bytes: await readFileBytes(node.path)
    });
  }
}
