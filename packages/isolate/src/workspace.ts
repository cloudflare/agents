import type { FileStat, Workspace } from "agents/experimental/workspace";
import type {
  StateArchiveCreateResult,
  StateArchiveEntry,
  StateArchiveExtractResult,
  StateApplyEditsOptions,
  StateApplyEditsResult,
  StateBackend,
  StateCapabilities,
  StateCompressionResult,
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
  parseJsonFileContent,
  planTextEdits,
  planToStateEdits,
  replaceTextContent,
  searchTextContent,
  stringifyJsonFileContent,
  toStateStat
} from "./helpers";

const WORKSPACE_CAPABILITIES: StateCapabilities = {
  chmod: false,
  utimes: false,
  hardLinks: false
};

export class WorkspaceStateBackend implements StateBackend {
  constructor(private readonly workspace: Workspace) {}

  async getCapabilities(): Promise<StateCapabilities> {
    return WORKSPACE_CAPABILITIES;
  }

  async readFile(path: string): Promise<string> {
    const value = await this.workspace.readFile(path);
    if (value === null) {
      throw new Error(`ENOENT: no such file: ${path}`);
    }
    return value;
  }

  async readFileBytes(path: string): Promise<Uint8Array> {
    const value = await this.workspace.readFileBytes(path);
    if (value === null) {
      throw new Error(`ENOENT: no such file: ${path}`);
    }
    return value;
  }

  async writeFile(path: string, content: string): Promise<void> {
    await this.workspace.writeFile(path, content);
  }

  async writeFileBytes(path: string, content: Uint8Array): Promise<void> {
    await this.workspace.writeFileBytes(path, content);
  }

  async appendFile(path: string, content: string | Uint8Array): Promise<void> {
    if (typeof content === "string") {
      await this.workspace.appendFile(path, content);
      return;
    }

    const existing = await this.workspace.readFileBytes(path);
    if (existing === null) {
      await this.workspace.writeFileBytes(path, content);
      return;
    }

    const combined = new Uint8Array(existing.byteLength + content.byteLength);
    combined.set(existing);
    combined.set(content, existing.byteLength);
    await this.workspace.writeFileBytes(path, combined);
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
    return this.workspace.exists(path);
  }

  async stat(path: string): Promise<StateStat | null> {
    const stat = this.workspace.stat(path);
    return stat ? fromWorkspaceStat(stat) : null;
  }

  async lstat(path: string): Promise<StateStat | null> {
    const stat = this.workspace.lstat(path);
    return stat ? fromWorkspaceStat(stat) : null;
  }

  async mkdir(path: string, options?: StateMkdirOptions): Promise<void> {
    this.workspace.mkdir(path, options);
  }

  async readdir(path: string): Promise<string[]> {
    return this.workspace.readDir(path).map((entry) => entry.name);
  }

  async readdirWithFileTypes(path: string): Promise<StateDirent[]> {
    return this.workspace
      .readDir(path)
      .map((entry) => ({ name: entry.name, type: entry.type }));
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

  async searchText(path: string, query: string, options?: StateSearchOptions) {
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
    await this.workspace.rm(path, options);
  }

  async cp(
    src: string,
    dest: string,
    options?: StateCopyOptions
  ): Promise<void> {
    const stat = this.workspace.lstat(src);
    if (stat?.type === "directory" && !options?.recursive) {
      throw new Error(
        `EISDIR: cannot copy directory without recursive: ${src}`
      );
    }
    await this.workspace.cp(src, dest, options);
  }

  async mv(
    src: string,
    dest: string,
    options?: StateMoveOptions
  ): Promise<void> {
    const stat = this.workspace.lstat(src);
    if (stat?.type === "directory" && !options?.recursive) {
      throw new Error(
        `EISDIR: cannot move directory without recursive: ${src}`
      );
    }
    await this.workspace.mv(src, dest, options);
  }

  async symlink(target: string, linkPath: string): Promise<void> {
    this.workspace.symlink(target, linkPath);
  }

  async readlink(path: string): Promise<string> {
    return this.workspace.readlink(path);
  }

  async realpath(path: string): Promise<string> {
    const stat = this.workspace.lstat(path);
    if (!stat) {
      throw new Error(`ENOENT: no such file or directory: ${path}`);
    }

    if (stat.type !== "symlink") {
      return normalizePath(path);
    }

    const target = this.workspace.readlink(path);
    const resolved = target.startsWith("/")
      ? normalizePath(target)
      : normalizePath(`${dirname(path)}/${target}`);
    return this.realpath(resolved);
  }

  async resolvePath(base: string, path: string): Promise<string> {
    return normalizePath(path.startsWith("/") ? path : `${base}/${path}`);
  }

  async glob(pattern: string): Promise<string[]> {
    return this.workspace.glob(pattern).map((entry) => entry.path);
  }

  async diff(pathA: string, pathB: string): Promise<string> {
    return this.workspace.diff(pathA, pathB);
  }

  async diffContent(path: string, newContent: string): Promise<string> {
    return this.workspace.diffContent(path, newContent);
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
        this.workspace.mkdir(destPath, { recursive: true });
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
    await this.workspace.rm(path, { recursive: true, force: true });
  }

  async copyTree(src: string, dest: string): Promise<void> {
    await this.workspace.cp(src, dest, { recursive: true });
  }

  async moveTree(src: string, dest: string): Promise<void> {
    await this.workspace.mv(src, dest, { recursive: true });
  }

  async planEdits(
    instructions: StateEditInstruction[]
  ): Promise<StateEditPlan> {
    return planTextEdits(
      instructions,
      async (path) => await this.workspace.readFile(path)
    );
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
      async (path) => await this.workspace.readFile(path),
      this.writeFile.bind(this),
      this.deleteFile.bind(this),
      options
    );
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
    await this.workspace.deleteFile(path);
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

export function createWorkspaceStateBackend(
  workspace: Workspace
): WorkspaceStateBackend {
  return new WorkspaceStateBackend(workspace);
}

function fromWorkspaceStat(stat: FileStat): StateStat {
  return toStateStat({
    type: stat.type,
    size: stat.size,
    mtime: new Date(stat.updatedAt)
  });
}

function normalizePath(path: string): string {
  if (!path.startsWith("/")) {
    path = "/" + path;
  }

  const parts = path.split("/");
  const resolved: string[] = [];
  for (const part of parts) {
    if (part === "" || part === ".") {
      continue;
    }
    if (part === "..") {
      resolved.pop();
    } else {
      resolved.push(part);
    }
  }

  return "/" + resolved.join("/");
}

function dirname(path: string): string {
  const normalized = normalizePath(path);
  if (normalized === "/") {
    return "/";
  }

  const lastSlash = normalized.lastIndexOf("/");
  return lastSlash <= 0 ? "/" : normalized.slice(0, lastSlash);
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
