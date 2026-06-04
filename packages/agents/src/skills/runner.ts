import { RpcTarget } from "cloudflare:workers";
import { DynamicWorkerExecutor, resolveProvider } from "@cloudflare/codemode";
import type { ToolProvider } from "@cloudflare/codemode";
import { Bash, defineCommand } from "just-bash";
import type { ToolSet } from "ai";
import type {
  SkillScriptRequest,
  SkillScriptRunner,
  SkillScriptContext
} from "./types";
import { validateSkillResourcePath } from "./types";

/**
 * Minimal workspace surface the skill runner needs. A concrete `Workspace`
 * from `@cloudflare/shell` (or Think's `WorkspaceLike`) satisfies this
 * structurally, so the runner does not depend on a filesystem package.
 */
export interface SkillWorkspace {
  readFile(path: string): Promise<string | null>;
  writeFile(path: string, content: string): Promise<void>;
  readDir(path: string): Promise<unknown>;
  glob(pattern: string): Promise<unknown>;
  stat(path: string): Promise<{ type: string; size?: number } | null>;
}

/**
 * Options for {@link runner}.
 *
 * @experimental Skill script execution is experimental and the option shape
 * may change before stabilizing.
 */
export interface WorkerSkillScriptRunnerOptions {
  loader: WorkerLoader;
  timeout?: number;
  network?: boolean;
  workspace?: "none" | "read" | "read-write";
  workspaceInstance?: SkillWorkspace;
  tools?: ToolSet | (() => ToolSet | Promise<ToolSet>);
}

type SkillScriptRuntime = "javascript" | "typescript" | "python" | "bash";
type WorkspaceAccess = "none" | "read" | "read-write";

const DEFAULT_SCRIPT_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_ARTIFACT_BYTES = 64_000;
const MAX_OUTPUT_ARTIFACTS = 20;

const SUPPORTED_SCRIPT_EXTENSIONS = new Set([
  ".js",
  ".mjs",
  ".ts",
  ".tsx",
  ".py",
  ".sh",
  ".bash"
]);

// Logged once per isolate the first time a skill script actually runs.
let runnerExperimentalWarned = false;

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

function validateMountedResourcePaths(request: SkillScriptRequest): void {
  for (const resource of request.resources ?? []) {
    const pathError = validateSkillResourcePath(resource.path);
    if (pathError) throw new Error(pathError);
  }
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

/**
 * Text bundled resources exposed to function-style JS/TS scripts via
 * `ctx.files`. Binary resources are omitted in v1.
 */
function textFilesMap(request: SkillScriptRequest): Record<string, string> {
  const files: Record<string, string> = {};
  for (const resource of request.resources ?? []) {
    if ((resource.encoding ?? "text") === "text") {
      files[resource.path] = resource.content;
    }
  }
  return files;
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function stdinText(stdin: unknown): string {
  return typeof stdin === "string" ? stdin : String(stdin ?? "");
}

// ── Python / Bash file mounting (path-based contract) ─────────────────

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

// ── JS/TS function-style wrapper ──────────────────────────────────────

/**
 * Wrap a function-style JS/TS skill module so it runs inside the codemode
 * sandbox. The module must `export default` an async `run(input, ctx)`; we
 * rewrite the default export to a local binding, build the `ctx` capability
 * object from the host bridge proxy (`__host`), and invoke it.
 */
function scriptModule(source: string, request: SkillScriptRequest): string {
  const runnableSource = stripStrayExports(
    source.replace(/^\s*export\s+default\s+/m, "const __skillRun = ")
  );
  const skillMeta = skillScriptContext(request).skill;

  return [
    "async () => {",
    `  const input = ${JSON.stringify(request.input)};`,
    `  const __skill = ${JSON.stringify(skillMeta)};`,
    `  const __files = ${JSON.stringify(textFilesMap(request))};`,
    "  const workspace = {",
    "    readFile: (path) => __host.readFile(path),",
    '    listFiles: (path = ".") => __host.listFiles(path),',
    "    glob: (pattern) => __host.glob(pattern),",
    "    stat: (path) => __host.stat(path),",
    "    writeFile: (path, content) => __host.writeFile({ path, content })",
    "  };",
    "  const tools = new Proxy(",
    "    { call: (name, input) => __host.callTool({ name, input }) },",
    "    {",
    "      get: (target, prop) =>",
    "        prop in target",
    "          ? target[prop]",
    "          : (input) => __host.callTool({ name: String(prop), input })",
    "    }",
    "  );",
    "  const output = {",
    "    writeFile: (name, content) => __host.writeOutput({ name, content })",
    "  };",
    "  const ctx = { skill: __skill, files: __files, workspace, tools, output };",
    "",
    runnableSource,
    "",
    '  if (typeof __skillRun !== "function") {',
    '    throw new Error("Skill script default export must be a function (input, ctx).");',
    "  }",
    "  return await __skillRun(input, ctx);",
    "}"
  ].join("\n");
}

function moduleSource(
  module: string | { js?: string; cjs?: string } | undefined
): string | null {
  if (typeof module === "string") return module;
  return module?.js ?? module?.cjs ?? null;
}

/**
 * Remove `export { ... }` blocks (illegal inside the function wrapper) and
 * rewrite a `export { X as default }` binding to the local `__skillRun`.
 */
function stripStrayExports(source: string): string {
  return source.replace(/\n?export\s*\{[\s\S]*?\};?/g, "");
}

function rewriteBundledSource(source: string): string {
  const defaultExport = source.match(
    /export\s*\{\s*([A-Za-z_$][\w$]*)\s+as\s+default\s*\};?/m
  );
  let out = source;
  if (defaultExport) {
    out = out.replace(
      defaultExport[0],
      `const __skillRun = ${defaultExport[1]};`
    );
  }
  return stripStrayExports(out);
}

async function prepareJavaScriptSource(
  request: SkillScriptRequest,
  runtime: "javascript" | "typescript"
): Promise<string> {
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

  // Only compile when TypeScript or when sibling script files need bundling.
  const needsBundler =
    runtime === "typescript" || Object.keys(files).length > 1;
  if (!needsBundler) return request.source;

  const { createWorker } = await import("@cloudflare/worker-bundler");
  const result = await createWorker({
    files,
    entryPoint: request.path,
    bundle: true
  });
  const compiled =
    moduleSource(result.modules[result.mainModule]) ??
    moduleSource(Object.values(result.modules)[0]);

  if (!compiled) {
    throw new Error(`Failed to compile skill script: ${request.path}`);
  }

  return rewriteBundledSource(compiled);
}

// ── Host bridge: single capability + permission surface ───────────────

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

interface OutputArtifact {
  path: string;
  encoding: "text";
  content: string;
}

/**
 * The single source of truth for skill-script capabilities and permission
 * enforcement. Every runtime delegates here:
 *
 * - JavaScript/TypeScript reach it through a codemode `ToolProvider`.
 * - Python receives it as an RPC `RpcTarget` (JSON-marshalling methods).
 * - Bash calls it from `just-bash` custom commands.
 *
 * Construct a fresh bridge per `run()` so the per-invocation `/output`
 * artifact buffer is never shared between concurrent script runs.
 */
class SkillScriptHostBridge extends RpcTarget {
  readonly #tools: ToolSet | undefined;
  readonly #workspace: SkillWorkspace | undefined;
  readonly #workspaceAccess: WorkspaceAccess;
  readonly #outputs = new Map<string, OutputArtifact>();

  constructor(
    tools: ToolSet | undefined,
    workspace: SkillWorkspace | undefined,
    workspaceAccess: WorkspaceAccess
  ) {
    super();
    this.#tools = tools;
    this.#workspace = workspace;
    this.#workspaceAccess = workspaceAccess;
  }

  // ── Introspection (host-side only) ──
  get workspaceAccess(): WorkspaceAccess {
    return this.#workspaceAccess;
  }

  hasTools(): boolean {
    return Boolean(this.#tools && Object.keys(this.#tools).length > 0);
  }

  // ── Canonical capability surface ──
  async callTool(name: string, input: unknown): Promise<unknown> {
    return executeToolFromSet(this.#tools, name, input);
  }

  async readFile(path: string): Promise<string | null> {
    return this.#requireWorkspace("read").readFile(path);
  }

  async listFiles(path = "."): Promise<unknown> {
    return this.#requireWorkspace("read").readDir(path);
  }

  async glob(pattern: string): Promise<unknown> {
    return this.#requireWorkspace("read").glob(pattern);
  }

  async stat(path: string): Promise<{ type: string; size: number } | null> {
    const info = await this.#requireWorkspace("read").stat(path);
    if (!info) return null;
    return { type: info.type, size: info.size ?? 0 };
  }

  async writeFile(path: string, content: string): Promise<void> {
    await this.#requireWorkspace("read-write").writeFile(path, content);
  }

  writeOutput(name: string, content: string): void {
    const key = String(name);
    const text = typeof content === "string" ? content : String(content ?? "");
    const bytes = new TextEncoder().encode(text).byteLength;
    if (bytes > MAX_OUTPUT_ARTIFACT_BYTES) {
      throw new Error(
        `Output artifact "${key}" exceeds ${MAX_OUTPUT_ARTIFACT_BYTES} bytes.`
      );
    }
    if (!this.#outputs.has(key) && this.#outputs.size >= MAX_OUTPUT_ARTIFACTS) {
      throw new Error(
        `Too many skill output artifacts (max ${MAX_OUTPUT_ARTIFACTS}).`
      );
    }
    this.#outputs.set(key, { path: key, encoding: "text", content: text });
  }

  getOutputFiles(): OutputArtifact[] {
    return [...this.#outputs.values()];
  }

  // ── Python-facing JSON marshalling (delegates to canonical surface) ──
  async tool(name: string, inputJson = "{}"): Promise<string> {
    try {
      const input = inputJson.trim() ? JSON.parse(inputJson) : {};
      return stringifyHostResult(await this.callTool(name, input));
    } catch (error) {
      return stringifyHostError(error);
    }
  }

  async workspaceReadFile(path: string): Promise<string> {
    try {
      return stringifyHostResult(await this.readFile(path));
    } catch (error) {
      return stringifyHostError(error);
    }
  }

  async workspaceListFiles(path = "."): Promise<string> {
    try {
      return stringifyHostResult(await this.listFiles(path));
    } catch (error) {
      return stringifyHostError(error);
    }
  }

  async workspaceGlob(pattern: string): Promise<string> {
    try {
      return stringifyHostResult(await this.glob(pattern));
    } catch (error) {
      return stringifyHostError(error);
    }
  }

  async workspaceWriteFile(path: string, content: string): Promise<string> {
    try {
      await this.writeFile(path, content);
      return stringifyHostResult(null);
    } catch (error) {
      return stringifyHostError(error);
    }
  }

  #requireWorkspace(access: "read" | "read-write"): SkillWorkspace {
    if (!this.#workspace || this.#workspaceAccess === "none") {
      throw new Error("Workspace access is not available.");
    }
    if (access === "read-write" && this.#workspaceAccess !== "read-write") {
      throw new Error("Workspace write access is not available.");
    }
    return this.#workspace;
  }
}

/**
 * Expose the bridge to JS/TS scripts as a single codemode provider namespace
 * (`__host`). The sandbox `ctx` object wraps these calls into the friendly
 * `workspace` / `tools` / `output` surface (see {@link scriptModule}).
 */
function hostProvider(bridge: SkillScriptHostBridge): ToolProvider {
  return {
    name: "__host",
    tools: {
      callTool: {
        execute: (a: unknown) => {
          const { name, input } = a as { name: string; input: unknown };
          return bridge.callTool(name, input);
        }
      },
      readFile: {
        execute: (a: unknown) => bridge.readFile(String(a))
      },
      listFiles: {
        execute: (a: unknown) =>
          bridge.listFiles(typeof a === "string" ? a : ".")
      },
      glob: {
        execute: (a: unknown) => bridge.glob(String(a))
      },
      stat: {
        execute: (a: unknown) => bridge.stat(String(a))
      },
      writeFile: {
        execute: (a: unknown) => {
          const { path, content } = a as { path: string; content: string };
          return bridge.writeFile(path, content);
        }
      },
      writeOutput: {
        execute: async (a: unknown) => {
          const { name, content } = a as { name: string; content: string };
          bridge.writeOutput(name, content);
          return null;
        }
      }
    }
  };
}

// ── Python runtime ────────────────────────────────────────────────────

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

async function runPythonScript(
  request: SkillScriptRequest,
  options: WorkerSkillScriptRunnerOptions,
  bridge: SkillScriptHostBridge
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

  const execution = entrypoint.evaluate(
    request.input,
    skillScriptContext(request),
    bridge,
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

// ── Bash runtime ──────────────────────────────────────────────────────

async function runBashScript(
  request: SkillScriptRequest,
  options: WorkerSkillScriptRunnerOptions,
  bridge: SkillScriptHostBridge
): Promise<unknown> {
  const customCommands = [];

  if (bridge.workspaceAccess !== "none") {
    customCommands.push(
      defineCommand("workspace-read", async (args) => {
        const path = args[0];
        if (!path) return { stdout: "", stderr: "Missing path\n", exitCode: 2 };
        try {
          return {
            stdout: (await bridge.readFile(path)) ?? "",
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
      }),
      defineCommand("workspace-list", async (args) => {
        const path = args[0] ?? ".";
        try {
          return {
            stdout: JSON.stringify(await bridge.listFiles(path)) + "\n",
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
      }),
      defineCommand("workspace-glob", async (args) => {
        const pattern = args[0];
        if (!pattern) {
          return { stdout: "", stderr: "Missing pattern\n", exitCode: 2 };
        }
        try {
          return {
            stdout: JSON.stringify(await bridge.glob(pattern)) + "\n",
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

    if (bridge.workspaceAccess === "read-write") {
      customCommands.push(
        defineCommand("workspace-write", async (args, ctx) => {
          const path = args[0];
          if (!path) {
            return { stdout: "", stderr: "Missing path\n", exitCode: 2 };
          }
          try {
            await bridge.writeFile(path, stdinText(ctx.stdin));
            return { stdout: "", stderr: "", exitCode: 0 };
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
  }

  if (bridge.hasTools()) {
    customCommands.push(
      defineCommand("tool", async (args, ctx) => {
        const name = args[0];
        if (!name) {
          return { stdout: "", stderr: "Missing tool name\n", exitCode: 2 };
        }
        try {
          const rawInput = args[1] ?? stdinText(ctx.stdin) ?? "{}";
          const input = rawInput.trim() ? JSON.parse(rawInput) : {};
          const result = await bridge.callTool(name, input);
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

// ── JavaScript / TypeScript runtime ───────────────────────────────────

async function runJavaScriptScript(
  request: SkillScriptRequest,
  options: WorkerSkillScriptRunnerOptions,
  bridge: SkillScriptHostBridge,
  runtime: "javascript" | "typescript"
): Promise<unknown> {
  if (!/^\s*export\s+default\s+/m.test(request.source)) {
    throw new Error(
      "JS/TS skill scripts must `export default` an async run(input, ctx) function."
    );
  }

  const source = await prepareJavaScriptSource(request, runtime);
  const executor = new DynamicWorkerExecutor({
    loader: options.loader,
    timeout: effectiveTimeout(options),
    globalOutbound: options.network ? undefined : null
  });
  const result = await executor.execute(scriptModule(source, request), [
    resolveProvider(hostProvider(bridge))
  ]);

  if (result.error) {
    const logs = result.logs?.length
      ? `\n\nConsole output:\n${result.logs.join("\n")}`
      : "";
    throw new Error(`${result.error}${logs}`);
  }

  const outputFiles = bridge.getOutputFiles();
  if (result.logs?.length || outputFiles.length > 0) {
    return {
      result: result.result,
      ...(result.logs?.length ? { logs: result.logs } : {}),
      ...(outputFiles.length > 0 ? { outputFiles } : {})
    };
  }

  return result.result;
}

/**
 * Create a skill script runner backed by a Worker Loader.
 *
 * Capabilities are opt-in and enforced by a single host bridge: no network and
 * no tools by default, read-only workspace access when `workspaceInstance` is
 * provided. JS/TS scripts are function-style (`export default run(input, ctx)`)
 * and receive `ctx = { skill, files, workspace, tools, output }`. Python and
 * Bash use the path-based `/skill`, `/input.json`, `/output` contract.
 *
 * @experimental Skill script execution is experimental and may change before
 * stabilizing.
 */
export function runner(
  options: WorkerSkillScriptRunnerOptions
): SkillScriptRunner {
  return {
    async run(request: SkillScriptRequest) {
      if (!runnerExperimentalWarned) {
        runnerExperimentalWarned = true;
        console.warn(
          "[think] skills.runner script execution is experimental; the API and capabilities may change."
        );
      }

      const tools =
        typeof options.tools === "function"
          ? await options.tools()
          : options.tools;
      const validation = validateSkillScriptPath(request.path);
      if (!validation.ok) throw new Error(validation.error);
      validateMountedResourcePaths(request);

      // Fresh bridge per run so /output artifacts never leak between
      // concurrent script invocations.
      const bridge = new SkillScriptHostBridge(
        tools,
        options.workspaceInstance,
        effectiveWorkspaceAccess(options)
      );

      if (validation.runtime === "bash") {
        return await runBashScript(request, options, bridge);
      }

      if (validation.runtime === "python") {
        return await runPythonScript(request, options, bridge);
      }

      return await runJavaScriptScript(
        request,
        options,
        bridge,
        validation.runtime
      );
    }
  };
}
