import { RpcTarget } from "cloudflare:workers";
import type { ToolProvider } from "@cloudflare/codemode";
import type { ToolSet } from "ai";
import type { WorkspaceLike } from "../tools/workspace";
import type {
  SkillScriptRequest,
  SkillScriptRunner,
  SkillScriptContext
} from "./types";
import { validateSkillResourcePath } from "./types";

export interface WorkerSkillScriptRunnerOptions {
  loader: WorkerLoader;
  timeout?: number;
  network?: boolean;
  workspace?: "none" | "read" | "read-write";
  workspaceInstance?: WorkspaceLike;
  tools?: ToolSet | (() => ToolSet | Promise<ToolSet>);
}

type SkillScriptRuntime = "javascript" | "typescript" | "python" | "bash";
type WorkspaceAccess = "none" | "read" | "read-write";

const DEFAULT_SCRIPT_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_ARTIFACT_BYTES = 64_000;

const SUPPORTED_SCRIPT_EXTENSIONS = new Set([
  ".js",
  ".mjs",
  ".ts",
  ".tsx",
  ".py",
  ".sh",
  ".bash"
]);

function extensionOf(path: string): string {
  const file = path.split("/").at(-1) ?? path;
  const index = file.lastIndexOf(".");
  return index === -1 ? "" : file.slice(index).toLowerCase();
}

function effectiveTimeout(options: WorkerSkillScriptRunnerOptions): number {
  return options.timeout ?? DEFAULT_SCRIPT_TIMEOUT_MS;
}

function effectiveWorkspaceAccess(
  options: WorkerSkillScriptRunnerOptions
): WorkspaceAccess {
  if (options.workspace) return options.workspace;
  return options.workspaceInstance ? "read" : "none";
}

export function validateSkillScriptPath(path: string):
  | {
      ok: true;
      runtime: SkillScriptRuntime;
    }
  | {
      ok: false;
      error: string;
    } {
  if (!path.startsWith("scripts/")) {
    return {
      ok: false,
      error: `Skill script path must start with "scripts/": ${path}`
    };
  }

  if (
    path.startsWith("/") ||
    path.includes("\0") ||
    path.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    return {
      ok: false,
      error: `Skill script path must be a normalized relative path under "scripts/": ${path}`
    };
  }

  const extension = extensionOf(path);
  if (!SUPPORTED_SCRIPT_EXTENSIONS.has(extension)) {
    return {
      ok: false,
      error: `Unsupported skill script extension "${extension || "(none)"}" for ${path}. Supported extensions: ${[...SUPPORTED_SCRIPT_EXTENSIONS].join(", ")}`
    };
  }

  if (extension === ".sh" || extension === ".bash") {
    return { ok: true, runtime: "bash" };
  }
  if (extension === ".py") {
    return { ok: true, runtime: "python" };
  }
  if (extension === ".ts" || extension === ".tsx") {
    return { ok: true, runtime: "typescript" };
  }
  return { ok: true, runtime: "javascript" };
}

function workspaceProvider(
  workspace: WorkspaceLike,
  access: "read" | "read-write"
): ToolProvider {
  const tools: ToolProvider["tools"] = {
    readFile: {
      description: "Read a workspace file as text.",
      execute: async (input: unknown) => {
        const path =
          typeof input === "object" &&
          input !== null &&
          typeof (input as { path?: unknown }).path === "string"
            ? (input as { path: string }).path
            : String(input);
        return workspace.readFile(path);
      }
    },
    listFiles: {
      description: "List files in a workspace directory.",
      execute: async (input: unknown) => {
        const path =
          typeof input === "object" &&
          input !== null &&
          typeof (input as { path?: unknown }).path === "string"
            ? (input as { path: string }).path
            : ".";
        return workspace.readDir(path);
      }
    },
    glob: {
      description: "Find workspace files by glob pattern.",
      execute: async (input: unknown) => {
        const pattern =
          typeof input === "object" &&
          input !== null &&
          typeof (input as { pattern?: unknown }).pattern === "string"
            ? (input as { pattern: string }).pattern
            : String(input);
        return workspace.glob(pattern);
      }
    },
    stat: {
      description: "Get workspace file metadata.",
      execute: async (input: unknown) => {
        const path =
          typeof input === "object" &&
          input !== null &&
          typeof (input as { path?: unknown }).path === "string"
            ? (input as { path: string }).path
            : String(input);
        return workspace.stat(path);
      }
    }
  };

  if (access === "read-write") {
    tools.writeFile = {
      description: "Write a workspace file.",
      execute: async (input: unknown) => {
        if (
          typeof input !== "object" ||
          input === null ||
          typeof (input as { path?: unknown }).path !== "string" ||
          typeof (input as { content?: unknown }).content !== "string"
        ) {
          throw new Error("writeFile requires { path, content }.");
        }
        const { path, content } = input as { path: string; content: string };
        await workspace.writeFile(path, content);
      }
    };
  }

  return { name: "workspace", tools };
}

function mountedFiles(request: SkillScriptRequest): Record<
  string,
  {
    content: string;
    encoding: "text" | "base64";
  }
> {
  const files: Record<
    string,
    {
      content: string;
      encoding: "text" | "base64";
    }
  > = {
    "/input.json": {
      content: JSON.stringify(request.input),
      encoding: "text"
    },
    "/context.json": {
      content: JSON.stringify(skillScriptContext(request)),
      encoding: "text"
    },
    "/skill/SKILL.md": {
      content: request.skill.rawContent ?? request.skill.body,
      encoding: "text"
    }
  };

  for (const resource of request.resources ?? []) {
    const pathError = validateSkillResourcePath(resource.path);
    if (pathError) throw new Error(pathError);
    files[`/skill/${resource.path}`] = {
      content: resource.content,
      encoding: resource.encoding ?? "text"
    };
  }
  files[`/skill/${request.path}`] = {
    content: request.source,
    encoding: "text"
  };

  return files;
}

function validateMountedResourcePaths(request: SkillScriptRequest): void {
  for (const resource of request.resources ?? []) {
    const pathError = validateSkillResourcePath(resource.path);
    if (pathError) throw new Error(pathError);
  }
}

function scriptModule(
  source: string,
  request: SkillScriptRequest,
  functionStyle: boolean
) {
  const input = request.input;
  const ctx = skillScriptContext(request);
  const runnableSource = source.includes("export default")
    ? source.replace(/^\s*export\s+default\s+/m, "const __skillRun = ")
    : source;

  return [
    "async () => {",
    "globalThis.__thinkSkillFsRuntime = { outputFiles: {} };",
    `globalThis.input = ${JSON.stringify(input)};`,
    `globalThis.ctx = ${JSON.stringify(ctx)};`,
    "",
    functionStyle ? runnableSource : source,
    "",
    ...(functionStyle
      ? [
          'if (typeof __skillRun !== "function") {',
          '  throw new Error("Skill script default export must be a function.");',
          "}",
          `return { __skillScriptMode: "function", result: await __skillRun(${JSON.stringify(input)}, ${JSON.stringify(ctx)}), outputFiles: Object.values(globalThis.__thinkSkillFsRuntime.outputFiles) };`
        ]
      : [
          `return { __skillScriptMode: "cli", stdout: "", stderr: "", exitCode: 0, outputFiles: Object.values(globalThis.__thinkSkillFsRuntime.outputFiles) };`
        ]),
    "}"
  ].join("\n");
}

function stdinText(stdin: unknown): string {
  return typeof stdin === "string" ? stdin : String(stdin ?? "");
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function bashFiles(
  request: SkillScriptRequest
): Record<string, string | Uint8Array> {
  const files: Record<string, string | Uint8Array> = {
    "/input.json": JSON.stringify(request.input),
    "/context.json": JSON.stringify(skillScriptContext(request)),
    "/skill-script.sh": request.source,
    "/skill/SKILL.md": request.skill.rawContent ?? request.skill.body,
    [`/skill/${request.path}`]: request.source
  };

  for (const resource of request.resources ?? []) {
    const pathError = validateSkillResourcePath(resource.path);
    if (pathError) throw new Error(pathError);
    files[`/skill/${resource.path}`] =
      (resource.encoding ?? "text") === "base64"
        ? base64ToBytes(resource.content)
        : resource.content;
  }

  return files;
}

function scriptFileTable(request: SkillScriptRequest): Record<
  string,
  {
    content: string;
    encoding: "text" | "base64";
  }
> {
  return mountedFiles(request);
}

function skillFileTableModule(request: SkillScriptRequest): string {
  return `export const files = ${JSON.stringify(scriptFileTable(request))};\n`;
}

function skillPathModule(): string {
  return `
function normalize(path) {
  const raw = String(path);
  const absolute = raw.startsWith("/") ? raw : \`/skill/\${raw}\`;
  const parts = [];
  for (const part of absolute.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return "/" + parts.join("/");
}

export function join(...parts) {
  return normalize(parts.join("/"));
}

export function resolve(...parts) {
  return normalize(parts.join("/"));
}

export function dirname(path) {
  const normalized = normalize(path);
  return normalized.split("/").slice(0, -1).join("/") || "/";
}

export function basename(path) {
  return normalize(path).split("/").at(-1) || "";
}

export function extname(path) {
  const base = basename(path);
  const index = base.lastIndexOf(".");
  return index === -1 ? "" : base.slice(index);
}

export default {
  join,
  resolve,
  dirname,
  basename,
  extname
};
`;
}

function skillFsModule(workspaceAccess: WorkspaceAccess): string {
  const canReadWorkspace = workspaceAccess !== "none";
  const canWriteWorkspace = workspaceAccess === "read-write";
  return `
import { files } from "virtual:think-skill-files";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
const canReadWorkspace = ${JSON.stringify(canReadWorkspace)};
const canWriteWorkspace = ${JSON.stringify(canWriteWorkspace)};
const maxOutputArtifactBytes = ${MAX_OUTPUT_ARTIFACT_BYTES};

function runtime() {
  const existing = globalThis.__thinkSkillFsRuntime;
  if (existing) return existing;
  const created = { outputFiles: {} };
  globalThis.__thinkSkillFsRuntime = created;
  return created;
}

function bytesToBase64(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function normalize(path) {
  const raw = String(path);
  const absolute = raw.startsWith("/") ? raw : \`/skill/\${raw}\`;
  const parts = [];
  for (const part of absolute.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return "/" + parts.join("/");
}

function workspacePath(path) {
  const normalized = normalize(path);
  if (normalized === "/workspace") return ".";
  if (normalized.startsWith("/workspace/")) {
    return normalized.slice("/workspace/".length);
  }
  return null;
}

function outputPath(path) {
  const raw = String(path);
  const normalized = raw.startsWith("/") ? normalize(raw) : raw;
  if (normalized === "/output") return null;
  if (normalized.startsWith("/output/")) return normalized;
  return null;
}

function outputFile(path) {
  return runtime().outputFiles[normalize(path)] ?? null;
}

function localFile(path) {
  const normalized = normalize(path);
  return files[normalized] ?? outputFile(normalized);
}

function fileToBytes(file) {
  return file.encoding === "base64"
    ? base64ToBytes(file.content)
    : textEncoder.encode(file.content);
}

function decodeFile(file, encoding) {
  if (encoding === null || encoding === undefined) return fileToBytes(file);
  const normalizedEncoding =
    typeof encoding === "string"
      ? encoding.toLowerCase()
      : String(encoding?.encoding ?? "utf8").toLowerCase();
  if (normalizedEncoding === "buffer") return fileToBytes(file);
  if (normalizedEncoding === "base64") {
    return file.encoding === "base64" ? file.content : bytesToBase64(fileToBytes(file));
  }
  if (file.encoding === "base64") return textDecoder.decode(fileToBytes(file));
  return file.content;
}

function bytesFromData(data, encoding) {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  const text = String(data);
  if (String(encoding ?? "").toLowerCase() === "base64") return base64ToBytes(text);
  return textEncoder.encode(text);
}

function textFromData(data, encoding) {
  if (typeof data === "string") return data;
  return textDecoder.decode(bytesFromData(data, encoding));
}

function writeOutput(path, data, encoding) {
  const target = outputPath(path);
  if (!target) {
    throw new Error("Skill scripts can only write to /output/... or async /workspace/... with write access.");
  }
  const bytes = bytesFromData(data, encoding);
  if (bytes.byteLength > maxOutputArtifactBytes) {
    throw new Error(
      \`Output artifact exceeds \${maxOutputArtifactBytes} bytes: \${target}\`
    );
  }
  const isText = typeof data === "string" && String(encoding ?? "utf8").toLowerCase() !== "base64";
  const file = isText
    ? { path: target, encoding: "text", content: String(data) }
    : { path: target, encoding: "base64", content: bytesToBase64(bytes) };
  runtime().outputFiles[target] = file;
}

function readLocal(path, encoding) {
  if (workspacePath(path) !== null) {
    throw new Error("Synchronous workspace access is not supported. Use fs.promises.readFile().");
  }
  const file = localFile(path);
  if (!file) throw new Error(\`File not found in skill filesystem: \${normalize(path)}\`);
  return decodeFile(file, encoding);
}

async function readWorkspace(path, encoding) {
  if (!canReadWorkspace) throw new Error("Workspace access is not available.");
  const content = await workspace.readFile({ path });
  if (content === null || content === undefined) {
    throw new Error(\`Workspace file not found: \${path}\`);
  }
  if (encoding === null || encoding === undefined) {
    return textEncoder.encode(String(content));
  }
  return String(content);
}

async function writeWorkspace(path, data, encoding) {
  if (!canWriteWorkspace) throw new Error("Workspace write access is not available.");
  await workspace.writeFile({ path, content: textFromData(data, encoding) });
}

export function readFileSync(path, encoding = "utf8") {
  return readLocal(path, encoding);
}

export function writeFileSync(path, data, encoding = "utf8") {
  if (workspacePath(path) !== null) {
    throw new Error("Synchronous workspace writes are not supported. Use fs.promises.writeFile().");
  }
  writeOutput(path, data, encoding);
}

export function existsSync(path) {
  if (workspacePath(path) !== null) {
    throw new Error("Synchronous workspace access is not supported. Use fs.promises.readFile().");
  }
  return Boolean(localFile(path));
}

export function readdirSync(path = "/skill") {
  if (workspacePath(path) !== null) {
    throw new Error("Synchronous workspace access is not supported. Use fs.promises.readdir().");
  }
  const prefix = normalize(path).replace(/\\/$/, "") + "/";
  return [
    ...new Set(
      Object.keys({ ...files, ...runtime().outputFiles })
        .filter((file) => file.startsWith(prefix))
        .map((file) => file.slice(prefix.length).split("/")[0])
        .filter(Boolean)
    )
  ];
}

export function statSync(path) {
  if (workspacePath(path) !== null) {
    throw new Error("Synchronous workspace access is not supported. Use fs.promises.stat().");
  }
  const file = localFile(path);
  const normalized = normalize(path);
  const isDirectory = Object.keys({ ...files, ...runtime().outputFiles }).some((filePath) =>
    filePath.startsWith(normalized.replace(/\\/$/, "") + "/")
  );
  if (!file && !isDirectory) {
    throw new Error(\`File not found in skill filesystem: \${normalized}\`);
  }
  return {
    isFile: () => Boolean(file),
    isDirectory: () => !file && isDirectory,
    size: file ? fileToBytes(file).byteLength : 0
  };
}

export async function readFile(path, encoding = "utf8") {
  const workspaceTarget = workspacePath(path);
  if (workspaceTarget !== null) return readWorkspace(workspaceTarget, encoding);
  return readLocal(path, encoding);
}

export async function writeFile(path, data, encoding = "utf8") {
  const workspaceTarget = workspacePath(path);
  if (workspaceTarget !== null) {
    return writeWorkspace(workspaceTarget, data, encoding);
  }
  writeOutput(path, data, encoding);
}

export async function readdir(path = "/skill") {
  const workspaceTarget = workspacePath(path);
  if (workspaceTarget !== null) {
    if (!canReadWorkspace) throw new Error("Workspace access is not available.");
    const entries = await workspace.listFiles({ path: workspaceTarget });
    return entries.map((entry) => entry.name ?? entry.path);
  }
  return readdirSync(path);
}

export async function stat(path) {
  const workspaceTarget = workspacePath(path);
  if (workspaceTarget !== null) {
    if (!canReadWorkspace) throw new Error("Workspace access is not available.");
    const result = await workspace.stat({ path: workspaceTarget });
    if (!result) {
      throw new Error(\`Workspace file not found: \${workspaceTarget}\`);
    }
    return {
      isFile: () => result.type === "file",
      isDirectory: () => result.type === "directory",
      size: result.size ?? 0
    };
  }
  return statSync(path);
}

export const promises = {
  readFile,
  writeFile,
  readdir,
  stat
};

export default {
  readFileSync,
  writeFileSync,
  existsSync,
  readdirSync,
  statSync,
  promises
};
`;
}

function skillFsPromisesModule(): string {
  return `
export {
  readFile,
  writeFile,
  readdir,
  stat,
  promises as default
} from "node:fs";
`;
}

function skillVirtualModules(
  request: SkillScriptRequest,
  workspaceAccess: WorkspaceAccess
): Record<string, string> {
  const files = skillFileTableModule(request);
  const fs = skillFsModule(workspaceAccess);
  const fsPromises = skillFsPromisesModule();
  const path = skillPathModule();

  return {
    "virtual:think-skill-files": files,
    fs,
    "node:fs": fs,
    "fs/promises": fsPromises,
    "node:fs/promises": fsPromises,
    path,
    "node:path": path
  };
}

function skillScriptContext(request: SkillScriptRequest): SkillScriptContext {
  return {
    skill: {
      name: request.skill.name,
      description: request.skill.description,
      compatibility: request.skill.compatibility,
      license: request.skill.license,
      allowedTools: request.skill.allowedTools,
      metadata: request.skill.metadata,
      sourceId: request.skill.sourceId,
      version: request.skill.version
    }
  };
}

async function executeToolFromSet(
  tools: ToolSet | undefined,
  name: string,
  input: unknown
): Promise<unknown> {
  const target = tools?.[name];
  const execute =
    target && "execute" in target
      ? (target.execute as ((input: unknown) => Promise<unknown>) | undefined)
      : undefined;

  if (!execute) throw new Error(`Tool not available: ${name}`);
  return execute(input);
}

function stringifyHostResult(result: unknown): string {
  return JSON.stringify({ result });
}

function stringifyHostError(error: unknown): string {
  return JSON.stringify({
    error: error instanceof Error ? error.message : String(error)
  });
}

class SkillScriptHostBridge extends RpcTarget {
  readonly #tools: ToolSet | undefined;
  readonly #workspace: WorkspaceLike | undefined;
  readonly #workspaceAccess: "none" | "read" | "read-write";

  constructor(
    tools: ToolSet | undefined,
    workspace: WorkspaceLike | undefined,
    workspaceAccess: "none" | "read" | "read-write"
  ) {
    super();
    this.#tools = tools;
    this.#workspace = workspace;
    this.#workspaceAccess = workspaceAccess;
  }

  async tool(name: string, inputJson = "{}"): Promise<string> {
    try {
      const input = inputJson.trim() ? JSON.parse(inputJson) : {};
      return stringifyHostResult(
        await executeToolFromSet(this.#tools, name, input)
      );
    } catch (error) {
      return stringifyHostError(error);
    }
  }

  async workspaceReadFile(path: string): Promise<string> {
    try {
      const workspace = this.#requireWorkspace("read");
      return stringifyHostResult(await workspace.readFile(path));
    } catch (error) {
      return stringifyHostError(error);
    }
  }

  async workspaceListFiles(path = "."): Promise<string> {
    try {
      const workspace = this.#requireWorkspace("read");
      return stringifyHostResult(await workspace.readDir(path));
    } catch (error) {
      return stringifyHostError(error);
    }
  }

  async workspaceGlob(pattern: string): Promise<string> {
    try {
      const workspace = this.#requireWorkspace("read");
      return stringifyHostResult(await workspace.glob(pattern));
    } catch (error) {
      return stringifyHostError(error);
    }
  }

  async workspaceWriteFile(path: string, content: string): Promise<string> {
    try {
      const workspace = this.#requireWorkspace("read-write");
      await workspace.writeFile(path, content);
      return stringifyHostResult(null);
    } catch (error) {
      return stringifyHostError(error);
    }
  }

  #requireWorkspace(access: "read" | "read-write"): WorkspaceLike {
    if (!this.#workspace || this.#workspaceAccess === "none") {
      throw new Error("Workspace access is not available.");
    }
    if (access === "read-write" && this.#workspaceAccess !== "read-write") {
      throw new Error("Workspace write access is not available.");
    }
    return this.#workspace;
  }
}

function pythonScriptModule(request: SkillScriptRequest): string {
  const source = request.source;
  const sourceLiteral = JSON.stringify(source);
  const filesLiteral = JSON.stringify(mountedFiles(request));

  return String.raw`
import asyncio
import base64
import contextlib
import inspect
import io
import json
import os
import sys
import time
import types
from js import Object
from pyodide.ffi import to_js as pyodide_to_js
from workers import WorkerEntrypoint

SKILL_SOURCE = ${sourceLiteral}
SKILL_FILES = ${filesLiteral}

async def maybe_await(value):
    if inspect.isawaitable(value):
        return await value
    return value

async def decode_host_response(raw):
    data = json.loads(str(raw))
    if "error" in data:
        raise Exception(data["error"])
    return data.get("result")

def to_js(obj):
    return pyodide_to_js(obj, dict_converter=Object.fromEntries)

def materialize_files():
    os.makedirs("/output", exist_ok=True)
    for path, file in SKILL_FILES.items():
        directory = os.path.dirname(path)
        if directory:
            os.makedirs(directory, exist_ok=True)
        mode = "wb" if file.get("encoding") == "base64" else "w"
        with open(path, mode) as handle:
            if file.get("encoding") == "base64":
                handle.write(base64.b64decode(file.get("content", "")))
            else:
                handle.write(file.get("content", ""))

def collect_output_files():
    output_files = []
    if not os.path.isdir("/output"):
        return output_files

    for root, _dirs, files in os.walk("/output"):
        for name in sorted(files):
            path = os.path.join(root, name)
            with open(path, "rb") as handle:
                content = handle.read()
            if len(content) > ${MAX_OUTPUT_ARTIFACT_BYTES}:
                raise Exception(f"Output artifact exceeds ${MAX_OUTPUT_ARTIFACT_BYTES} bytes: {path}")
            try:
                output_files.append({
                    "path": path,
                    "encoding": "text",
                    "content": content.decode("utf-8")
                })
            except UnicodeDecodeError:
                output_files.append({
                    "path": path,
                    "encoding": "base64",
                    "content": base64.b64encode(content).decode("ascii")
                })

    return sorted(output_files, key=lambda file: file["path"])

def looks_function_style(source):
    return "def run(" in source or "async def run(" in source

def timeout_trace(deadline):
    def trace(frame, event, arg):
        if time.monotonic() > deadline:
            raise TimeoutError("Python script execution timed out")
        return trace
    return trace

class ToolNamespace:
    def __init__(self, host):
        self.host = host

    async def call(self, name, input=None):
        raw = await self.host.tool(name, json.dumps(input if input is not None else {}))
        return await decode_host_response(raw)

    def __getattr__(self, name):
        async def call_tool(input=None):
            return await self.call(name, input)
        return call_tool

class WorkspaceNamespace:
    def __init__(self, host):
        self.host = host

    async def read_file(self, path):
        raw = await self.host.workspaceReadFile(path)
        return await decode_host_response(raw)

    async def list_files(self, path="."):
        raw = await self.host.workspaceListFiles(path)
        return await decode_host_response(raw)

    async def glob(self, pattern):
        raw = await self.host.workspaceGlob(pattern)
        return await decode_host_response(raw)

    async def write_file(self, path, content):
        raw = await self.host.workspaceWriteFile(path, content)
        return await decode_host_response(raw)

class Default(WorkerEntrypoint):
    async def evaluate(self, input, ctx, host, timeout_ms=None):
        materialize_files()
        try:
            if looks_function_style(SKILL_SOURCE):
                skill_module = types.ModuleType("skill_script")
                skill_module.tools = ToolNamespace(host)
                skill_module.workspace = WorkspaceNamespace(host)
                exec(SKILL_SOURCE, skill_module.__dict__)
                if not hasattr(skill_module, "run") or not callable(skill_module.run):
                    raise Exception("Python function-style skill script must define a callable run(input, ctx).")
                execution = maybe_await(skill_module.run(input, ctx))
                previous_trace = sys.gettrace()
                if timeout_ms is not None:
                    sys.settrace(timeout_trace(time.monotonic() + (timeout_ms / 1000)))
                try:
                    if timeout_ms is not None:
                        result = await asyncio.wait_for(execution, timeout_ms / 1000)
                    else:
                        result = await execution
                finally:
                    sys.settrace(previous_trace)
                return to_js({
                    "result": result,
                    "logs": [],
                    "mode": "function",
                    "outputFiles": collect_output_files()
                })

            stdout = io.StringIO()
            stderr = io.StringIO()
            previous_stdin = sys.stdin
            previous_trace = sys.gettrace()
            if timeout_ms is not None:
                sys.settrace(timeout_trace(time.monotonic() + (timeout_ms / 1000)))
            sys.stdin = io.StringIO(json.dumps(input))
            try:
                namespace = {"__name__": "__main__", "__file__": "/skill/script.py"}
                with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
                    exec(SKILL_SOURCE, namespace)
            finally:
                sys.stdin = previous_stdin
                sys.settrace(previous_trace)
            return to_js({
                "result": {
                    "stdout": stdout.getvalue(),
                    "stderr": stderr.getvalue(),
                    "exitCode": 0
                },
                "logs": [],
                "mode": "cli",
                "outputFiles": collect_output_files()
            })
        except TimeoutError:
            return to_js({"error": "Python script execution timed out", "logs": []})
        except SystemExit as err:
            return to_js({
                "result": {
                    "stdout": stdout.getvalue() if "stdout" in locals() else "",
                    "stderr": stderr.getvalue() if "stderr" in locals() else "",
                    "exitCode": int(err.code) if isinstance(err.code, int) else 1
                },
                "logs": [],
                "mode": "cli",
                "outputFiles": collect_output_files()
            })
        except asyncio.TimeoutError:
            return to_js({"error": "Python script execution timed out", "logs": []})
        except Exception as err:
            return to_js({"error": str(err), "logs": []})
`;
}

async function runBashScript(
  request: SkillScriptRequest,
  options: WorkerSkillScriptRunnerOptions,
  tools: ToolSet | undefined
): Promise<unknown> {
  const { Bash, defineCommand } = await import("just-bash");
  const customCommands = [];
  const workspaceAccess = effectiveWorkspaceAccess(options);

  if (workspaceAccess !== "none") {
    const workspace = options.workspaceInstance;
    if (!workspace) {
      throw new Error(
        "workspaceInstance is required when skill script workspace access is enabled."
      );
    }

    customCommands.push(
      defineCommand("workspace-read", async (args) => {
        const path = args[0];
        if (!path) return { stdout: "", stderr: "Missing path\n", exitCode: 2 };
        return {
          stdout: (await workspace.readFile(path)) ?? "",
          stderr: "",
          exitCode: 0
        };
      }),
      defineCommand("workspace-list", async (args) => {
        const path = args[0] ?? ".";
        return {
          stdout: JSON.stringify(await workspace.readDir(path)) + "\n",
          stderr: "",
          exitCode: 0
        };
      }),
      defineCommand("workspace-glob", async (args) => {
        const pattern = args[0];
        if (!pattern) {
          return { stdout: "", stderr: "Missing pattern\n", exitCode: 2 };
        }
        return {
          stdout: JSON.stringify(await workspace.glob(pattern)) + "\n",
          stderr: "",
          exitCode: 0
        };
      })
    );

    if (workspaceAccess === "read-write") {
      customCommands.push(
        defineCommand("workspace-write", async (args, ctx) => {
          const path = args[0];
          if (!path) {
            return { stdout: "", stderr: "Missing path\n", exitCode: 2 };
          }
          await workspace.writeFile(path, stdinText(ctx.stdin));
          return { stdout: "", stderr: "", exitCode: 0 };
        })
      );
    }
  }

  if (tools && Object.keys(tools).length > 0) {
    customCommands.push(
      defineCommand("tool", async (args, ctx) => {
        const name = args[0];
        if (!name) {
          return { stdout: "", stderr: "Missing tool name\n", exitCode: 2 };
        }
        try {
          const rawInput = args[1] ?? stdinText(ctx.stdin) ?? "{}";
          const input = rawInput.trim() ? JSON.parse(rawInput) : {};
          const result = await executeToolFromSet(tools, name, input);
          return {
            stdout: JSON.stringify(result) + "\n",
            stderr: "",
            exitCode: 0
          };
        } catch (error) {
          return {
            stdout: "",
            stderr: `${error instanceof Error ? error.message : String(error)}\n`,
            exitCode: 1
          };
        }
      })
    );
  }

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    effectiveTimeout(options)
  );

  try {
    const bash = new Bash({
      files: bashFiles(request),
      customCommands,
      defenseInDepth: true,
      network: options.network ? {} : undefined
    });
    const result = await bash.exec("bash /skill-script.sh", {
      signal: controller.signal,
      stdin: JSON.stringify(request.input)
    });

    return {
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode
    };
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function moduleSource(
  module: string | { js?: string; cjs?: string } | undefined
): string | null {
  if (typeof module === "string") return module;
  return module?.js ?? module?.cjs ?? null;
}

function stripEsmExportBlock(source: string): string {
  return source.replace(/\n?export\s*\{[\s\S]*?\};?/g, "");
}

function rewriteBundledSource(source: string, functionStyle: boolean): string {
  const defaultExport = source.match(
    /export\s*\{\s*([A-Za-z_$][\w$]*)\s+as\s+default\s*\};?/m
  );
  if (functionStyle && defaultExport) {
    return source.replace(
      defaultExport[0],
      `const __skillRun = ${defaultExport[1]};`
    );
  }
  if (!functionStyle) {
    return stripEsmExportBlock(source);
  }
  return source;
}

async function prepareJavaScriptSource(
  request: SkillScriptRequest,
  runtime: "javascript" | "typescript",
  workspaceAccess: WorkspaceAccess,
  functionStyle: boolean
): Promise<string> {
  const { createWorker } = await import("@cloudflare/worker-bundler");
  const files: Record<string, string> = {};
  for (const resource of request.resources ?? []) {
    const extension = extensionOf(resource.path);
    if (
      resource.kind === "script" &&
      (resource.encoding ?? "text") === "text" &&
      [".js", ".mjs", ".ts", ".tsx"].includes(extension)
    ) {
      files[resource.path] = resource.content;
    }
  }
  files[request.path] = request.source;
  const virtualModules = skillVirtualModules(request, workspaceAccess);
  const fsCompatImports = [
    request.source,
    ...Object.entries(files)
      .filter(([path]) => path !== request.path)
      .map(([, content]) => content)
  ].some(
    (source) =>
      /\bfrom\s+["'](?:node:)?(?:fs|fs\/promises|path)["']/.test(source) ||
      /\bimport\s*\(\s*["'](?:node:)?(?:fs|fs\/promises|path)["']\s*\)/.test(
        source
      )
  );
  const needsBundler =
    runtime === "typescript" ||
    Object.keys(files).length > 1 ||
    fsCompatImports;
  if (!needsBundler) return request.source;

  const result = await createWorker({
    files,
    entryPoint: request.path,
    bundle: Object.keys(files).length > 1 || fsCompatImports,
    virtualModules:
      Object.keys(files).length > 1 || fsCompatImports
        ? virtualModules
        : undefined
  });
  const compiled =
    moduleSource(result.modules[result.mainModule]) ??
    moduleSource(Object.values(result.modules)[0]);

  if (!compiled) {
    throw new Error(`Failed to compile skill script: ${request.path}`);
  }

  return rewriteBundledSource(compiled, functionStyle);
}

async function runJavaScriptScript(
  request: SkillScriptRequest,
  options: WorkerSkillScriptRunnerOptions,
  tools: ToolSet | undefined,
  runtime: "javascript" | "typescript"
): Promise<unknown> {
  const { DynamicWorkerExecutor, resolveProvider } =
    await import("@cloudflare/codemode");
  const providers: ReturnType<typeof resolveProvider>[] = [];
  const workspaceAccess = effectiveWorkspaceAccess(options);

  if (workspaceAccess !== "none") {
    if (!options.workspaceInstance) {
      throw new Error(
        "workspaceInstance is required when skill script workspace access is enabled."
      );
    }
    providers.push(
      resolveProvider(
        workspaceProvider(options.workspaceInstance, workspaceAccess)
      )
    );
  }

  if (tools && Object.keys(tools).length > 0) {
    providers.push(resolveProvider({ name: "tools", tools } as ToolProvider));
  }

  const functionStyle = /^\s*export\s+default\s+/m.test(request.source);
  const source =
    runtime === "typescript" || runtime === "javascript"
      ? await prepareJavaScriptSource(
          request,
          runtime,
          workspaceAccess,
          functionStyle
        )
      : request.source;
  const executor = new DynamicWorkerExecutor({
    loader: options.loader,
    timeout: effectiveTimeout(options),
    globalOutbound: options.network ? undefined : null
  });
  const result = await executor.execute(
    scriptModule(source, request, functionStyle),
    providers
  );

  if (result.error) {
    const logs = result.logs?.length
      ? `\n\nConsole output:\n${result.logs.join("\n")}`
      : "";
    throw new Error(`${result.error}${logs}`);
  }

  if (
    typeof result.result === "object" &&
    result.result !== null &&
    (result.result as { __skillScriptMode?: unknown }).__skillScriptMode ===
      "cli"
  ) {
    const outputFiles =
      (result.result as { outputFiles?: unknown[] }).outputFiles ?? [];
    return {
      stdout: result.logs?.length ? `${result.logs.join("\n")}\n` : "",
      stderr: (result.result as { stderr?: string }).stderr ?? "",
      exitCode: (result.result as { exitCode?: number }).exitCode ?? 0,
      ...(outputFiles.length > 0 ? { outputFiles } : {})
    };
  }

  if (
    typeof result.result === "object" &&
    result.result !== null &&
    (result.result as { __skillScriptMode?: unknown }).__skillScriptMode ===
      "function"
  ) {
    const functionResult = (result.result as { result?: unknown }).result;
    const outputFiles =
      (result.result as { outputFiles?: unknown[] }).outputFiles ?? [];
    if (result.logs?.length || outputFiles.length > 0) {
      return {
        result: functionResult,
        ...(result.logs?.length ? { logs: result.logs } : {}),
        ...(outputFiles.length > 0 ? { outputFiles } : {})
      };
    }
    return functionResult;
  }

  return result.logs?.length
    ? { result: result.result, logs: result.logs }
    : result.result;
}

async function runPythonScript(
  request: SkillScriptRequest,
  options: WorkerSkillScriptRunnerOptions,
  tools: ToolSet | undefined
): Promise<unknown> {
  const worker = options.loader.get(
    `skill-python-${crypto.randomUUID()}`,
    () => ({
      compatibilityDate: "2026-05-23",
      compatibilityFlags: ["python_workers", "disable_python_external_sdk"],
      mainModule: "skill_runner.py",
      modules: {
        "skill_runner.py": pythonScriptModule(request)
      },
      globalOutbound: options.network ? undefined : null
    })
  );

  const entrypoint = worker.getEntrypoint() as unknown as {
    evaluate(
      input: unknown,
      ctx: SkillScriptContext,
      host: SkillScriptHostBridge,
      timeoutMs?: number
    ): Promise<{
      result?: unknown;
      error?: string;
      logs?: string[];
      mode?: "cli" | "function";
      outputFiles?: unknown[];
    }>;
  };

  const host = new SkillScriptHostBridge(
    tools,
    options.workspaceInstance,
    effectiveWorkspaceAccess(options)
  );
  const execution = entrypoint.evaluate(
    request.input,
    skillScriptContext(request),
    host,
    effectiveTimeout(options)
  );
  let timeout: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(
      () => reject(new Error("Python script execution timed out")),
      effectiveTimeout(options)
    );
  });

  try {
    const response = await Promise.race([execution, timeoutPromise]);
    if (response.error) {
      throw new Error(response.error);
    }

    const outputFiles = response.outputFiles ?? [];

    if (response.mode === "cli") {
      if (
        typeof response.result === "object" &&
        response.result !== null &&
        outputFiles.length > 0
      ) {
        return {
          ...response.result,
          outputFiles
        };
      }
      return response.result;
    }

    if (response.logs?.length || outputFiles.length > 0) {
      return {
        result: response.result,
        ...(response.logs?.length ? { logs: response.logs } : {}),
        ...(outputFiles.length > 0 ? { outputFiles } : {})
      };
    }

    return response.result;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export function workerScriptRunner(
  options: WorkerSkillScriptRunnerOptions
): SkillScriptRunner {
  return {
    async run(request: SkillScriptRequest) {
      const tools =
        typeof options.tools === "function"
          ? await options.tools()
          : options.tools;
      const validation = validateSkillScriptPath(request.path);
      if (!validation.ok) throw new Error(validation.error);
      validateMountedResourcePaths(request);

      if (validation.runtime === "bash") {
        return runBashScript(request, options, tools);
      }

      if (validation.runtime === "python") {
        return runPythonScript(request, options, tools);
      }

      return runJavaScriptScript(request, options, tools, validation.runtime);
    }
  };
}
