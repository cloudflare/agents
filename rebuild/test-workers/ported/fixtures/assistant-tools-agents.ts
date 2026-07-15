import {
  Think,
  hostAgent,
  type AgentHost,
  type ModelChunk,
  type ModelClient
} from "../compat.js";
import { scoped } from "../../../src/ports/storage.js";
import {
  createWorkspace,
  globToRegExp,
  type Workspace
} from "../../../src/domain/workspace/workspace.js";

type SeedFile = { path: string; content: string };
type GrepMatch = {
  path: string;
  line: number;
  text: string;
  context?: string;
};

const rpcMethodNames = [
  "seed",
  "seedBytes",
  "seedDir",
  "seedLargeFile",
  "toolRead",
  "toolReadModelOutput",
  "toolWrite",
  "toolEdit",
  "toolList",
  "toolFind",
  "toolGrep",
  "toolBash"
] as const;

type DispatchAgent = {
  __dispatchAssistantTools(method: string, args: unknown[]): Promise<unknown>;
};

type ShellWithAgent = {
  withAgent<T>(fn: (agent: DispatchAgent) => T | Promise<T>): Promise<T>;
};

function installRpcMethods(target: { prototype: object }): void {
  for (const method of rpcMethodNames) {
    if (method in target.prototype) continue;
    Object.defineProperty(target.prototype, method, {
      value(this: ShellWithAgent, ...args: unknown[]) {
        return this.withAgent((agent) =>
          agent.__dispatchAssistantTools(method, args)
        );
      }
    });
  }
}

function stripSlash(path: string): string {
  return path.startsWith("/") ? path.slice(1) : path;
}

function withSlash(path: string): string {
  return path.startsWith("/") ? path : `/${path}`;
}

function basename(path: string): string {
  const clean = stripSlash(path);
  return clean.split("/").at(-1) ?? clean;
}

function parentDir(path: string): string | undefined {
  const clean = stripSlash(path);
  const index = clean.lastIndexOf("/");
  return index === -1 ? undefined : clean.slice(0, index);
}

function base64FromBytes(bytes: number[]): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function bytesFromBase64(base64: string): number[] {
  const binary = atob(base64);
  return Array.from(binary, (char) => char.charCodeAt(0));
}

function sniffMediaType(
  bytes: number[],
  declared?: string
): string | undefined {
  if (
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return "image/png";
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    bytes
      .slice(0, 6)
      .map((byte) => String.fromCharCode(byte))
      .join("") === "GIF89a"
  ) {
    return "image/gif";
  }
  if (
    bytes
      .slice(0, 4)
      .map((byte) => String.fromCharCode(byte))
      .join("") === "RIFF" &&
    bytes
      .slice(8, 12)
      .map((byte) => String.fromCharCode(byte))
      .join("") === "WEBP"
  ) {
    return "image/webp";
  }
  if (
    bytes
      .slice(0, 5)
      .map((byte) => String.fromCharCode(byte))
      .join("") === "%PDF-"
  ) {
    return "application/pdf";
  }
  return declared;
}

function isImage(mediaType?: string): boolean {
  return mediaType?.startsWith("image/") ?? false;
}

function globMatches(glob: string | undefined, path: string): boolean {
  if (glob === undefined) return true;
  const cleanGlob = stripSlash(glob);
  const cleanPath = stripSlash(path);
  if (globToRegExp(cleanGlob).test(cleanPath)) return true;
  if (cleanGlob.includes("/**/")) {
    return globToRegExp(cleanGlob.replace("/**/", "/")).test(cleanPath);
  }
  return false;
}

class TestAssistantToolsAgentImpl extends Think {
  private readonly toolWorkspace: Workspace;

  constructor(host: AgentHost) {
    super(host);
    this.toolWorkspace = createWorkspace({
      store: scoped(host.store, "assistant-tools:ws:"),
      clock: host.clock
    });
  }

  protected override getModel(): ModelClient {
    return {
      async *stream(): AsyncIterable<ModelChunk> {
        yield { type: "finish", finishReason: "stop" };
      }
    };
  }

  async __dispatchAssistantTools(
    method: string,
    args: unknown[]
  ): Promise<unknown> {
    const fn = (this as Record<string, unknown>)[method];
    if (typeof fn !== "function") {
      throw new Error(`Unknown RPC method: ${method}`);
    }
    return fn.apply(this, args);
  }

  async seed(files: SeedFile[]): Promise<void> {
    for (const file of files) {
      this.recordParentDirs(file.path);
      this.toolWorkspace.write(file.path, file.content);
    }
  }

  async seedBytes(
    path: string,
    bytes: number[],
    mediaType?: string
  ): Promise<void> {
    this.recordParentDirs(path);
    this.toolWorkspace.write(path, base64FromBytes(bytes), {
      encoding: "base64",
      mediaType
    });
  }

  async seedDir(path: string): Promise<void> {
    this.recordDir(path);
  }

  async seedLargeFile(path: string, sizeBytes: number): Promise<void> {
    const line = `${"x".repeat(99)}\n`;
    const lines = Math.ceil(sizeBytes / 100);
    await this.seed([{ path, content: line.repeat(lines) }]);
  }

  async toolRead(
    path: string,
    offset?: number,
    limit?: number
  ): Promise<unknown> {
    if (this.isRecordedDir(path)) {
      return { error: `${path} is a directory` };
    }
    const record = this.toolWorkspace.read(path);
    if (!record) return { error: `File not found: ${path}` };

    if (record.encoding === "base64") {
      const bytes = bytesFromBase64(record.content);
      const mediaType = sniffMediaType(bytes, record.mediaType);
      if (isImage(mediaType)) {
        return {
          kind: "image",
          path,
          name: basename(path),
          mediaType,
          sizeBytes: bytes.length
        };
      }
      if (mediaType === "application/pdf") {
        return {
          kind: "file",
          path,
          name: basename(path),
          mediaType,
          sizeBytes: bytes.length
        };
      }
      return {
        kind: "binary",
        path,
        name: basename(path),
        mediaType: mediaType ?? record.mediaType ?? "application/octet-stream",
        sizeBytes: bytes.length,
        unsupported: true
      };
    }

    const lines = record.content.split("\n");
    const fromLine = offset ?? 1;
    const toLine =
      limit === undefined
        ? lines.length
        : Math.min(lines.length, fromLine + limit - 1);
    const selected = lines.slice(fromLine - 1, toLine);
    return {
      path,
      content: selected
        .map((line, index) => `${fromLine + index}\t${line}`)
        .join("\n"),
      totalLines: lines.length,
      fromLine,
      toLine
    };
  }

  async toolReadModelOutput(
    path: string,
    offset?: number,
    limit?: number
  ): Promise<unknown> {
    void offset;
    void limit;
    const record = this.toolWorkspace.read(path);
    if (!record || record.encoding !== "base64") {
      return { type: "content", value: [] };
    }
    const bytes = bytesFromBase64(record.content);
    const mediaType = sniffMediaType(bytes, record.mediaType);
    if (isImage(mediaType)) {
      return {
        type: "content",
        value: [{ type: "image-data", data: record.content, mediaType }]
      };
    }
    if (mediaType === "application/pdf") {
      return {
        type: "content",
        value: [
          {
            type: "file-data",
            data: record.content,
            mediaType,
            filename: basename(path)
          }
        ]
      };
    }
    return { type: "content", value: [] };
  }

  async toolWrite(path: string, content: string): Promise<unknown> {
    this.recordParentDirs(path);
    this.toolWorkspace.write(path, content);
    return {
      path,
      bytesWritten: new TextEncoder().encode(content).length,
      lines: content.split("\n").length
    };
  }

  async toolEdit(
    path: string,
    old_string: string,
    new_string: string
  ): Promise<unknown> {
    if (old_string === "") {
      this.recordParentDirs(path);
      this.toolWorkspace.write(path, new_string);
      return { created: true };
    }
    const before = this.toolWorkspace.read(path);
    if (!before) return { error: `File not found: ${path}` };
    const result = this.toolWorkspace.edit(path, old_string, new_string);
    if (result.ok) return { replaced: true };
    if (result.reason === "no_match") {
      const fuzzy = this.fuzzyEdit(
        path,
        before.content,
        old_string,
        new_string
      );
      if (fuzzy === "ambiguous") {
        return { error: "old_string matched multiple locations" };
      }
      if (fuzzy) return { replaced: true, fuzzyMatch: true };
      return { error: "old_string not found" };
    }
    if (result.reason === "not_unique") {
      const count = before.content.split(old_string).length - 1;
      return { error: `old_string found ${count} times` };
    }
    return { error: `File not found: ${path}` };
  }

  async toolList(path = "/"): Promise<unknown> {
    const prefix = stripSlash(path);
    const files = this.toolWorkspace.list(path, { recursive: true });
    const entries = new Set<string>();
    for (const file of files) {
      const rel =
        prefix === "" ? file.path : file.path.slice(prefix.length + 1);
      const [first] = rel.split("/");
      if (!first) continue;
      entries.add(rel.includes("/") ? `${first}/` : first);
    }
    for (const dir of this.recordedDirs()) {
      const cleanDir = stripSlash(dir);
      if (prefix !== "" && !cleanDir.startsWith(`${prefix}/`)) continue;
      const rel = prefix === "" ? cleanDir : cleanDir.slice(prefix.length + 1);
      const [first] = rel.split("/");
      if (first) entries.add(`${first}/`);
    }
    const sorted = [...entries].sort();
    return { count: sorted.length, entries: sorted };
  }

  async toolFind(pattern: string): Promise<unknown> {
    const files = this.toolWorkspace
      .list("/", { recursive: true })
      .map((entry) => entry.path)
      .filter((path) => globMatches(pattern, path))
      .map(withSlash)
      .sort();
    return { count: files.length, files };
  }

  async toolGrep(
    query: string,
    include?: string,
    fixedString?: boolean,
    caseSensitive?: boolean,
    contextLines?: number
  ): Promise<unknown> {
    const matches: GrepMatch[] = [];
    let filesSkipped = 0;
    for (const entry of this.toolWorkspace.list("/", { recursive: true })) {
      if (!globMatches(include, entry.path)) continue;
      if (entry.size > 1_000_000) {
        filesSkipped++;
        continue;
      }
      const record = this.toolWorkspace.read(entry.path);
      if (!record || record.encoding !== "utf8") continue;
      const flags = caseSensitive ? "" : "i";
      const pattern = fixedString
        ? query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
        : query;
      const regex = new RegExp(pattern, flags);
      const lines = record.content.split("\n");
      for (let index = 0; index < lines.length; index++) {
        const text = lines[index] ?? "";
        if (!regex.test(text)) continue;
        const match: GrepMatch = {
          path: withSlash(entry.path),
          line: index + 1,
          text
        };
        if (contextLines !== undefined && contextLines > 0) {
          const start = Math.max(0, index - contextLines);
          const end = Math.min(lines.length, index + contextLines + 1);
          match.context = lines.slice(start, end).join("\n");
        }
        matches.push(match);
      }
    }
    return {
      totalMatches: matches.length,
      filesWithMatches: new Set(matches.map((match) => match.path)).size,
      filesSkipped,
      note: filesSkipped > 0 ? `${filesSkipped} files skipped` : "",
      matches
    };
  }

  async toolBash(): Promise<unknown> {
    throw new Error(
      "bash tool is not available in the rebuild workspace (ISSUE-005)"
    );
  }

  private fuzzyEdit(
    path: string,
    content: string,
    oldString: string,
    newString: string
  ): boolean | "ambiguous" {
    const compactNeedle = oldString.trim().replace(/\s+/g, "\\s+");
    const regex = new RegExp(compactNeedle, "g");
    const matches = [...content.matchAll(regex)];
    if (matches.length > 1) return "ambiguous";
    const first = matches[0];
    if (!first || first.index === undefined) return false;
    const match = first[0];
    this.toolWorkspace.write(
      path,
      `${content.slice(0, first.index)}${newString}${content.slice(
        first.index + match.length
      )}`
    );
    return true;
  }

  private recordParentDirs(path: string): void {
    const parent = parentDir(path);
    if (!parent) return;
    const pieces = parent.split("/");
    for (let i = 1; i <= pieces.length; i++) {
      this.recordDir(pieces.slice(0, i).join("/"));
    }
  }

  private recordDir(path: string): void {
    const dirs = this.recordedDirs();
    dirs.add(withSlash(stripSlash(path)));
    this.host.store.put("assistant-tools:dirs", [...dirs].sort());
  }

  private isRecordedDir(path: string): boolean {
    return this.recordedDirs().has(withSlash(stripSlash(path)));
  }

  private recordedDirs(): Set<string> {
    return new Set(this.host.store.get<string[]>("assistant-tools:dirs") ?? []);
  }
}

const TestAssistantToolsAgentBase = hostAgent(TestAssistantToolsAgentImpl);
export class TestAssistantToolsAgent extends TestAssistantToolsAgentBase {}

installRpcMethods(TestAssistantToolsAgent);
