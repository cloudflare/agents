import { RpcTarget } from "cloudflare:workers";
import type { ToolProvider } from "@cloudflare/codemode";
import type { ToolSet } from "ai";
import type { WorkspaceLike } from "../tools/workspace";
import type {
  SkillScriptRequest,
  SkillScriptRunner,
  SkillScriptContext
} from "./types";

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

function scriptModule(source: string, input: unknown, ctx: SkillScriptContext) {
  const runnableSource = source.replace(
    /^\s*export\s+default\s+/,
    "const __skillRun = "
  );

  return [
    "async () => {",
    runnableSource,
    "",
    'if (typeof __skillRun !== "function") {',
    '  throw new Error("Skill script must default export a function.");',
    "}",
    `return await __skillRun(${JSON.stringify(input)}, ${JSON.stringify(ctx)});`,
    "}"
  ].join("\n");
}

function stdinText(stdin: unknown): string {
  return typeof stdin === "string" ? stdin : String(stdin ?? "");
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

function pythonScriptModule(source: string): string {
  const sourceLiteral = JSON.stringify(source);

  return String.raw`
import asyncio
import inspect
import json
import types
from js import Object
from pyodide.ffi import to_js as pyodide_to_js
from workers import WorkerEntrypoint

skill_module = types.ModuleType("skill_script")
exec(${sourceLiteral}, skill_module.__dict__)

if not hasattr(skill_module, "run") or not callable(skill_module.run):
    raise Exception("Python skill script must define a callable run(input, ctx).")

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
        skill_module.tools = ToolNamespace(host)
        skill_module.workspace = WorkspaceNamespace(host)
        try:
            execution = maybe_await(skill_module.run(input, ctx))
            if timeout_ms is not None:
                result = await asyncio.wait_for(execution, timeout_ms / 1000)
            else:
                result = await execution
            return to_js({"result": result, "logs": []})
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
      files: {
        "/input.json": JSON.stringify(request.input),
        "/context.json": JSON.stringify({
          skill: {
            name: request.skill.name,
            description: request.skill.description
          }
        }),
        "/skill-script.sh": request.source
      },
      customCommands,
      defenseInDepth: true,
      network: options.network ? {} : undefined
    });
    const result = await bash.exec("bash /skill-script.sh", {
      signal: controller.signal,
      stdin: JSON.stringify(request.input)
    });

    if (result.exitCode !== 0) {
      throw new Error(
        `Bash script exited with code ${result.exitCode}: ${result.stderr}`
      );
    }

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

async function compileTypeScriptScript(
  request: SkillScriptRequest
): Promise<string> {
  const { createWorker } = await import("@cloudflare/worker-bundler");
  const result = await createWorker({
    files: {
      [request.path]: request.source
    },
    entryPoint: request.path,
    bundle: false
  });
  const compiled =
    moduleSource(result.modules[result.mainModule]) ??
    moduleSource(Object.values(result.modules)[0]);

  if (!compiled) {
    throw new Error(
      `Failed to compile TypeScript skill script: ${request.path}`
    );
  }

  return compiled;
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

  const source =
    runtime === "typescript"
      ? await compileTypeScriptScript(request)
      : request.source;
  const executor = new DynamicWorkerExecutor({
    loader: options.loader,
    timeout: effectiveTimeout(options),
    globalOutbound: options.network ? undefined : null
  });
  const result = await executor.execute(
    scriptModule(source, request.input, skillScriptContext(request)),
    providers
  );

  if (result.error) {
    const logs = result.logs?.length
      ? `\n\nConsole output:\n${result.logs.join("\n")}`
      : "";
    throw new Error(`${result.error}${logs}`);
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
        "skill_runner.py": pythonScriptModule(request.source)
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

    return response.logs?.length
      ? { result: response.result, logs: response.logs }
      : response.result;
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
