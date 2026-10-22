/**
 * Runs model-written JavaScript against a browser in a Dynamic Worker, with
 * a `cdp` object backed by a `BrowserSession`. Used by
 * `browserTool`. Internal — not an entry point.
 *
 * The Worker has no network access (`globalOutbound: null`) and no bindings:
 * the only way out is `cdp`, whose calls go back to the host over RPC.
 */
import { RpcTarget } from "cloudflare:workers";
import type { BrowserSession } from "./session";

/** What a run returns: the code's result or error, and its console output. */
export type BrowserCodeRun =
  | { result: unknown; logs: string[] }
  | { error: string; logs: string[] };

export interface RunBrowserCodeOptions {
  loader: WorkerLoader;
  /** The model's code: an async arrow function, or a function body. */
  code: string;
  /** The session `cdp` calls go to. */
  session: BrowserSession;
  /** How long the code may run before it fails. */
  timeoutMs: number;
}

/** The `cdp` methods code can call, each taking one options object. */
const CDP_METHODS = [
  "send",
  "attachToTarget",
  "spec",
  "getDebugLog",
  "clearDebugLog"
] as const;
type CdpMethod = (typeof CDP_METHODS)[number];

/**
 * The host side of `cdp`. A failed call resolves with `{ error }` instead of
 * rejecting across RPC; the sandbox rethrows it as a local error the code
 * can catch.
 */
class CdpBinding extends RpcTarget {
  readonly #session: BrowserSession;

  constructor(session: BrowserSession) {
    super();
    this.#session = session;
  }

  async call(
    method: string,
    input: unknown
  ): Promise<{ value: unknown } | { error: string }> {
    if (!isCdpMethod(method)) {
      return { error: `cdp.${method} is not a function.` };
    }
    try {
      return { value: await this.#invoke(method, input) };
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  }

  #invoke(method: CdpMethod, input: unknown): Promise<unknown> {
    const session = this.#session;
    switch (method) {
      // SAFETY: The session validates every input before using it.
      case "send":
        return session.send(input as Parameters<BrowserSession["send"]>[0]);
      case "attachToTarget":
        return session.attachToTarget(
          input as Parameters<BrowserSession["attachToTarget"]>[0]
        );
      case "spec":
        return session.spec();
      case "getDebugLog":
        return session.getDebugLog(
          input as Parameters<BrowserSession["getDebugLog"]>[0]
        );
      case "clearDebugLog":
        return session.clearDebugLog();
    }
  }
}

function isCdpMethod(method: string): method is CdpMethod {
  return (CDP_METHODS as readonly string[]).includes(method);
}

/**
 * The entry module. `code.js` holds the model's code; keeping it in its own
 * module keeps the harness's names out of its scope.
 */
function mainModule(timeoutMs: number): string {
  return `import { WorkerEntrypoint } from "cloudflare:workers";
import run from "./code.js";

export default class BrowserCode extends WorkerEntrypoint {
  async evaluate(binding) {
    const logs = [];
    const record = (prefix) => (...args) => {
      logs.push(prefix + args.map(String).join(" "));
    };
    console.log = record("");
    console.info = record("");
    console.warn = record("[warn] ");
    console.error = record("[error] ");
    const call = async (method, input) => {
      const reply = await binding.call(method, input);
      if ("error" in reply) throw new Error(reply.error);
      return reply.value;
    };
    const cdp = Object.freeze({
${CDP_METHODS.map((method) => `      ${method}: (input) => call(${JSON.stringify(method)}, input),`).join("\n")}
    });
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new Error("Execution timed out after ${timeoutMs}ms")),
        ${timeoutMs}
      );
    });
    try {
      return { result: await Promise.race([run(cdp), timeout]), logs };
    } catch (error) {
      return {
        error: error instanceof Error ? error.message : String(error),
        logs
      };
    } finally {
      clearTimeout(timer);
    }
  }
}
`;
}

/** Strip the markdown fences models often wrap code in. */
function stripFences(code: string): string {
  const fenced =
    /^```(?:js|javascript|typescript|ts|tsx|jsx)?\s*\n([\s\S]*?)```\s*$/;
  return code.trim().match(fenced)?.[1] ?? code.trim();
}

/**
 * The model's code as an expression: an async arrow function (what the tool
 * asks for) is called, and any other expression is awaited.
 */
function expressionModule(code: string): string {
  const expression = code
    .replace(/^export\s+default\s+/, "")
    .replace(/;\s*$/, "");
  return `export default async function (cdp) {
  const value = (
${expression}
  );
  return typeof value === "function" ? await value() : await value;
}
`;
}

/** The model's code as a function body, for statements with a `return`. */
function bodyModule(code: string): string {
  return `export default async function (cdp) {
${code}
}
`;
}

/** The Worker failed to start because a module didn't parse. */
function isSyntaxError(error: unknown): boolean {
  return error instanceof Error && /SyntaxError/.test(error.message);
}

/**
 * Run the model's code against `session` in a fresh Dynamic Worker.
 *
 * The code is first loaded as an expression (an async arrow function, as
 * the tool asks for). If that doesn't parse, it's loaded once more as a
 * function body, so statements ending in `return` work too. Errors thrown
 * by the code, including timeouts, come back as `{ error }`; this only
 * rejects when the Worker can't run at all.
 */
export async function runBrowserCode(
  options: RunBrowserCodeOptions
): Promise<BrowserCodeRun> {
  const code = stripFences(options.code);
  if (code === "") return { result: undefined, logs: [] };
  const binding = new CdpBinding(options.session);
  try {
    return await evaluate(options, expressionModule(code), binding);
  } catch (error) {
    if (!isSyntaxError(error)) throw error;
  }
  try {
    return await evaluate(options, bodyModule(code), binding);
  } catch (error) {
    if (!isSyntaxError(error)) throw error;
    return {
      error: `Your code didn't parse: ${(error as Error).message}. Write an async arrow function, async () => { ... }.`,
      logs: []
    };
  }
}

async function evaluate(
  options: RunBrowserCodeOptions,
  codeModule: string,
  binding: CdpBinding
): Promise<BrowserCodeRun> {
  // `load()`, not `get(id, ...)`: every run's code is different, so there
  // is nothing to cache by id.
  const worker = options.loader.load({
    compatibilityDate: "2025-06-01",
    mainModule: "main.js",
    modules: {
      "main.js": mainModule(options.timeoutMs),
      "code.js": codeModule
    },
    globalOutbound: null
  });
  // The loaded Worker and its entrypoint stub own native handles. Dispose
  // both once the run settles rather than leaving them to GC, which can
  // finalize them during isolate shutdown and crash workerd.
  try {
    const entrypoint = worker.getEntrypoint() as unknown as {
      evaluate(binding: CdpBinding): Promise<BrowserCodeRun>;
    };
    try {
      return await entrypoint.evaluate(binding);
    } finally {
      disposeQuietly(entrypoint);
    }
  } finally {
    disposeQuietly(worker);
  }
}

function disposeQuietly(resource: unknown): void {
  if (
    typeof resource !== "object" ||
    resource === null ||
    !(Symbol.dispose in resource)
  ) {
    return;
  }
  const dispose = (resource as { [Symbol.dispose]?: unknown })[Symbol.dispose];
  if (typeof dispose !== "function") return;
  try {
    (dispose as () => void).call(resource);
  } catch {
    // Disposal must never mask the run's result.
  }
}
