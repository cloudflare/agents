/**
 * Codemode as an extension: the model writes a script, and the tools are
 * functions it calls.
 *
 * Installed last (`after`), it makes every server tool before it callable
 * by code only, except those in `direct`, and adds one `code` tool whose
 * definition never changes. The functions are listed in a remind block,
 * so loading or unloading an extension changes neither the tools sent nor
 * the recorded prompt: the model gets one reminder.
 *
 * A function call is the harness's `invoke`: a recorded step under the
 * `code` call, with the tool hooks and the called tool's recovery rule.
 * `code` is a `rerun` tool, so a script cut off by a reset runs again and
 * each call it already made is answered from its step, in the order the
 * calls were made. The script runs on an `Executor` from
 * `@cloudflare/codemode`, which keeps nothing.
 *
 * @internal Not exported from any entry point. Imported only by a host
 * that installs it, so a harness without `@cloudflare/codemode` never
 * loads it.
 */
import { DurableObject } from "cloudflare:workers";
import {
  DynamicWorkerExecutor,
  generateTypesFromJsonSchema,
  normalizeCode,
  sanitizeToolName,
  truncateResult,
  type ExecuteResult,
  type Executor,
  type ResolvedProvider
} from "@cloudflare/codemode";
import { jsonSchema, type JSONSchema7 } from "ai";
import type { ThinkExtension, ToolInvoke } from "./types";

/** @internal */
export type CodemodeOptions = {
  /** Runs the scripts. */
  readonly executor: Executor;
  /** Tools the model keeps calling directly, besides `code`. */
  readonly direct?: readonly string[];
  /**
   * About how many tokens the function list may take in the prompt.
   * Default 4000. What doesn't fit is found with `codemode.search`.
   */
  readonly maxCatalogTokens?: number;
};

/** The `code` tool's name. @internal */
export const CODE_TOOL = "code";

/** The remind block that lists the functions. @internal */
export const CODEMODE_CATALOG = "codemode";

const DEFAULT_CATALOG_TOKENS = 4000;

const CODE_DESCRIPTION = [
  "Run a JavaScript async arrow function, and get what it returns.",
  "The tools you can call from it are async functions, one namespace per",
  'extension, each taking one object: `await workspace.read({ path: "a.txt" })`.',
  'They are listed, with their types, in the system prompt under "Functions',
  'for code". `await codemode.search("query")` finds others by name or',
  'description, and `await codemode.describe("namespace.name")` gives one\'s',
  "types. A function whose tool fails throws its error text. The script has",
  "no network. Return a value rather than printing it."
].join(" ");

const CODE_INPUT: JSONSchema7 = {
  type: "object",
  properties: {
    code: {
      type: "string",
      description: "The script: `async () => { ...; return result; }`"
    }
  },
  required: ["code"]
};

/** A tool as the type generator takes it. */
type Described = Parameters<typeof generateTypesFromJsonSchema>[0][string];

/** One function a script can call. */
type Fn = {
  readonly tool: string;
  readonly namespace: string;
  readonly name: string;
  readonly description: string;
  /** Its declaration, as one namespace with only it. */
  readonly declaration: string;
};

/** The functions and the catalog for one set of tools. */
type Catalog = { readonly fns: readonly Fn[]; readonly text: string };

/** The namespace an extension's tools are on: the harness's own are `tools`. */
function namespaceOf(owner: string): string {
  return sanitizeToolName(owner === "options" ? "tools" : owner);
}

function declare(
  namespace: string,
  tools: Parameters<typeof generateTypesFromJsonSchema>[0]
): string {
  return generateTypesFromJsonSchema(tools).replace(
    /declare const codemode:/,
    `declare const ${namespace}:`
  );
}

/**
 * The catalog within `budget` tokens (about four characters each). Each
 * namespace places its cheapest function before any places a second, and
 * every namespace is named even when none of its functions fits.
 */
function catalogOf(
  fns: readonly Fn[],
  entries: ReadonlyMap<string, Described>,
  budget: number
): string {
  const byNamespace = new Map<string, Fn[]>();
  for (const fn of fns) {
    const list = byNamespace.get(fn.namespace) ?? [];
    list.push(fn);
    byNamespace.set(fn.namespace, list);
  }
  for (const list of byNamespace.values()) {
    list.sort((a, b) => a.declaration.length - b.declaration.length);
  }
  const chosen = new Map<string, Fn[]>(
    [...byNamespace.keys()].map((namespace) => [namespace, []])
  );
  let left = budget * 4;
  for (let round = 0; ; round++) {
    let placed = false;
    for (const [namespace, list] of byNamespace) {
      const fn = list[round];
      if (!fn || fn.declaration.length > left) continue;
      chosen.get(namespace)?.push(fn);
      left -= fn.declaration.length;
      placed = true;
    }
    if (!placed) break;
  }
  const sections: string[] = [];
  for (const [namespace, list] of chosen) {
    const all = byNamespace.get(namespace) ?? [];
    const tools = Object.fromEntries(
      list.flatMap((fn) => {
        const entry = entries.get(fn.tool);
        return entry ? [[fn.name, entry] as const] : [];
      })
    );
    const missing = all.length - list.length;
    sections.push(
      (list.length > 0
        ? declare(namespace, tools)
        : `declare const ${namespace}: {};`) +
        (missing > 0
          ? `\n// ${namespace}: ${missing} more, found with codemode.search`
          : "")
    );
  }
  return sections.join("\n\n");
}

/** What a script's run gives the model: a header, the script, what it did. */
function report(
  code: string,
  ran: ExecuteResult,
  calls: readonly string[]
): unknown {
  const lines = [
    ran.error !== undefined
      ? `The script failed: ${ran.error}`
      : "The script returned.",
    "",
    "```js",
    code,
    "```",
    ""
  ];
  if (ran.error === undefined) {
    lines.push(`Result: ${JSON.stringify(ran.result) ?? "undefined"}`);
  }
  lines.push(`Calls: ${calls.length > 0 ? calls.join(", ") : "none"}`);
  if (ran.logs && ran.logs.length > 0) lines.push("Logs:", ...ran.logs);
  return truncateResult(lines.join("\n"));
}

/**
 * The sandbox object: a Durable Object that runs scripts in a dynamic
 * Worker it loads itself, so a script busy computing holds this object,
 * not the agent. The app exports the class from its Worker entry and
 * declares it (a binding and a migration); it keeps nothing.
 *
 * @internal
 */
export class CodemodeSandbox extends DurableObject<{ LOADER: WorkerLoader }> {
  /** Run a script; its functions are stubs back to the caller. */
  run(
    code: string,
    providers: ResolvedProvider[],
    timeout?: number
  ): Promise<ExecuteResult> {
    return new DynamicWorkerExecutor({
      loader: this.env.LOADER,
      ...(timeout !== undefined && { timeout })
    }).execute(code, providers);
  }
}

/**
 * An executor that runs each script in the agent's sandbox object, one
 * per agent (by `name`), instead of in this isolate.
 *
 * @internal
 */
export function sandboxExecutor(
  sandbox: DurableObjectNamespace<CodemodeSandbox>,
  name: string,
  options: { readonly timeout?: number } = {}
): Executor {
  return {
    async execute(code, providers) {
      if (!Array.isArray(providers)) {
        throw new Error("The sandbox executor takes resolved providers");
      }
      const stub = sandbox.get(sandbox.idFromName(name));
      // The providers' functions cross as stubs, so the sandbox's calls
      // come back here, to the harness.
      return (await stub.run(
        code,
        providers,
        options.timeout
      )) as ExecuteResult;
    }
  };
}

/** @internal */
export function codemodeExtension(options: CodemodeOptions): ThinkExtension {
  const direct = new Set(options.direct ?? []);
  const budget = options.maxCatalogTokens ?? DEFAULT_CATALOG_TOKENS;
  // Between one build's tools and prompt transforms, by session. Each
  // entry is taken by its prompt transform, so the map holds at most the
  // builds running at once.
  const catalogs = new Map<string, string>();
  // The last catalog made, by the tools it was made from: a build with the
  // same tools does no type generation.
  let last: { key: string; catalog: Catalog } | undefined;
  return (ctx) => {
    ctx.tools.transform((tools, { session }) => {
      const entries = new Map<string, Described>();
      const owners = new Map<string, string>();
      for (const name of [...tools.keys()]) {
        if (name === CODE_TOOL || direct.has(name)) continue;
        const entry = tools.get(name);
        if (!entry?.execute) continue;
        tools.setCallers(name, ["code"]);
        const description = entry.definition.description;
        entries.set(name, {
          ...(typeof description === "string" && { description }),
          inputSchema: entry.inputSchema,
          ...(entry.outputSchema && { outputSchema: entry.outputSchema })
        });
        owners.set(name, entry.owner);
      }
      const key = JSON.stringify([budget, [...entries], [...owners]]);
      if (last?.key !== key) {
        const fns: Fn[] = [...entries].map(([tool, entry]) => {
          const namespace = namespaceOf(owners.get(tool) ?? "tools");
          const name = sanitizeToolName(tool);
          return {
            tool,
            namespace,
            name,
            description:
              typeof entry.description === "string" ? entry.description : "",
            declaration: declare(namespace, { [name]: entry })
          };
        });
        last = {
          key,
          catalog: { fns, text: catalogOf(fns, entries, budget) }
        };
      }
      const catalog = last.catalog;
      catalogs.set(session, catalog.text);
      tools.set(CODE_TOOL, {
        description: CODE_DESCRIPTION,
        inputSchema: jsonSchema<{ code: string }>(CODE_INPUT),
        recovery: "rerun",
        execute: async (input: { code: string }, callOptions: unknown) => {
          const invoke = (callOptions as { invoke?: ToolInvoke }).invoke;
          if (!invoke) {
            return "The harness gives this tool no way to call others.";
          }
          const calls: string[] = [];
          const providers = new Map<string, ResolvedProvider>();
          for (const fn of catalog.fns) {
            const provider = providers.get(fn.namespace) ?? {
              name: fn.namespace,
              fns: {}
            };
            provider.fns[fn.name] = async (args: unknown) => {
              calls.push(`${fn.namespace}.${fn.name}`);
              const outcome = await invoke(fn.tool, args ?? {});
              if (!outcome.ok) throw new Error(outcome.errorText);
              return outcome.output;
            };
            providers.set(fn.namespace, provider);
          }
          // Read-only lookups over the catalog, answered here: no step.
          const lookup: ResolvedProvider = {
            name: "codemode",
            fns: {
              search: async (query: unknown) => {
                const words = String(query ?? "")
                  .toLowerCase()
                  .split(/\s+/)
                  .filter(Boolean);
                return catalog.fns
                  .filter((fn) => {
                    const text =
                      `${fn.namespace}.${fn.name} ${fn.description}`.toLowerCase();
                    return words.every((word) => text.includes(word));
                  })
                  .slice(0, 20)
                  .map((fn) => ({
                    name: `${fn.namespace}.${fn.name}`,
                    description: fn.description
                  }));
              },
              describe: async (name: unknown) =>
                catalog.fns.find(
                  (fn) => `${fn.namespace}.${fn.name}` === String(name)
                )?.declaration ?? null
            }
          };
          const code = normalizeCode(input.code);
          const ran = await options.executor.execute(code, [
            ...providers.values(),
            lookup
          ]);
          return report(input.code, ran, calls);
        }
      });
    });
    ctx.prompt.transform((prompt, { session }) => {
      const catalog = catalogs.get(session);
      catalogs.delete(session);
      if (!catalog) return;
      prompt.set(CODEMODE_CATALOG, {
        text: `Functions for code (call them from the \`${CODE_TOOL}\` tool):\n\n\`\`\`ts\n${catalog}\n\`\`\``,
        whenChanged: "remind",
        description: "The functions the code tool's scripts can call"
      });
    });
  };
}
