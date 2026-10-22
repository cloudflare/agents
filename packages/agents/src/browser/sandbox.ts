/**
 * Runs model-written JavaScript in a Dynamic Worker, with a `browser`
 * object whose functions run on the host. Used by `browserTool`.
 * Internal — not an entry point.
 *
 * The Worker has no network access (`globalOutbound: null`) and no bindings:
 * the only way out is `browser`, whose calls go back to the host over RPC.
 */
import { RpcTarget } from "cloudflare:workers";
import type { BrowserFunction } from "./module";

/**
 * What a run returns: the code's result or error, its console output, and a
 * `notice` for the model when the code likely didn't do what it meant.
 */
export type BrowserCodeRun =
  | { result: unknown; logs: string[]; notice?: string }
  | { error: string; logs: string[] };

/**
 * Code run as a function body returns nothing unless it says `return`. Tell
 * the model, rather than parse the code to return its last expression. A text
 * search for `return` can't tell a real one from one inside a string, so any
 * body run that comes back empty gets the notice.
 */
const STATEMENTS_NOTICE =
  "Your code ran as statements and returned nothing. If you wanted a value, `return` it, or write an async arrow function.";

export interface RunBrowserCodeOptions {
  loader: WorkerLoader;
  /** The model's code: an async arrow function, or a function body. */
  code: string;
  /** The functions on the `browser` global, run on the host. */
  functions: Record<string, BrowserFunction>;
  /** How long the code may run before it fails. */
  timeoutMs: number;
}

/**
 * The host side of `browser`. A failed call resolves with `{ error }`
 * instead of rejecting across RPC; the sandbox rethrows it as a local error
 * the code can catch.
 */
class HostFunctions extends RpcTarget {
  readonly #functions: Record<string, BrowserFunction>;

  constructor(functions: Record<string, BrowserFunction>) {
    super();
    this.#functions = functions;
  }

  async call(
    name: string,
    input: unknown
  ): Promise<{ value: unknown } | { error: string }> {
    const fn = Object.hasOwn(this.#functions, name)
      ? this.#functions[name]
      : undefined;
    if (!fn) return { error: `browser.${name} is not a function.` };
    try {
      return { value: await fn(input) };
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  }
}

/**
 * The entry module. `code.js` holds the model's code; keeping it in its own
 * module keeps the harness's names out of its scope.
 */
function mainModule(timeoutMs: number, names: string[]): string {
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
    const browser = Object.freeze({
${names.map((name) => `      ${JSON.stringify(name)}: (input) => call(${JSON.stringify(name)}, input),`).join("\n")}
    });
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new Error("Execution timed out after ${timeoutMs}ms")),
        ${timeoutMs}
      );
    });
    try {
      return { result: await Promise.race([run(browser), timeout]), logs };
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
  return `export default async function (browser) {
  const value = (
${expression}
  );
  return typeof value === "function" ? await value() : await value;
}
`;
}

/** The model's code as a function body, for statements with a `return`. */
function bodyModule(code: string): string {
  return `export default async function (browser) {
${code}
}
`;
}

/** The Worker failed to start because a module didn't parse. */
function isSyntaxError(error: unknown): boolean {
  return error instanceof Error && /SyntaxError/.test(error.message);
}

/**
 * Run the model's code in a fresh Dynamic Worker, with `browser` bound to
 * `functions`.
 *
 * The code is first loaded as an expression (an async arrow function, as
 * the tool asks for). If that doesn't parse, it's loaded once more as a
 * function body, so statements ending in `return` work too; statements
 * with no `return` at all get a `notice`. Errors thrown
 * by the code, including timeouts, come back as `{ error }`; this only
 * rejects when the Worker can't run at all.
 */
export async function runBrowserCode(
  options: RunBrowserCodeOptions
): Promise<BrowserCodeRun> {
  const code = stripFences(options.code);
  if (code === "") return { result: undefined, logs: [] };
  const binding = new HostFunctions(options.functions);
  try {
    return await evaluate(options, expressionModule(code), binding);
  } catch (error) {
    if (!isSyntaxError(error)) throw error;
  }
  let ran: BrowserCodeRun;
  try {
    ran = await evaluate(options, bodyModule(code), binding);
  } catch (error) {
    if (!isSyntaxError(error)) throw error;
    return {
      error: `Your code didn't parse: ${(error as Error).message}. Write an async arrow function, async () => { ... }.`,
      logs: []
    };
  }
  return "result" in ran && ran.result === undefined
    ? { ...ran, notice: STATEMENTS_NOTICE }
    : ran;
}

async function evaluate(
  options: RunBrowserCodeOptions,
  codeModule: string,
  binding: HostFunctions
): Promise<BrowserCodeRun> {
  // `load()`, not `get(id, ...)`: every run's code is different, so there
  // is nothing to cache by id.
  const worker = options.loader.load({
    compatibilityDate: "2025-06-01",
    mainModule: "main.js",
    modules: {
      "main.js": mainModule(options.timeoutMs, Object.keys(options.functions)),
      "code.js": codeModule
    },
    globalOutbound: null
  });
  // The loaded Worker and its entrypoint stub own native handles. Dispose
  // both once the run settles rather than leaving them to GC, which can
  // finalize them during isolate shutdown and crash workerd.
  try {
    const entrypoint = worker.getEntrypoint() as unknown as {
      evaluate(binding: HostFunctions): Promise<BrowserCodeRun>;
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
