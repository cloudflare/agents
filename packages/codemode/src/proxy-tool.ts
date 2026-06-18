/**
 * Model-facing proxy tool.
 *
 * One AI SDK tool with `{ code: string }`. Code runs in the Executor sandbox.
 * The CodemodeRuntime facet makes execution durable via abort-and-replay:
 * every tool call is logged; reads execute and record; approval-required
 * actions abort the run; `continue` replays the log and runs the approved action.
 *
 * Inside the sandbox:
 *   - Connector SDKs as globals: `<connector>.<method>(...)`
 *   - Platform SDK: `codemode.search/describe/step/run`
 *
 * ## Sequencing
 *
 * The host (this module) owns the replay cursor: a per-run counter allocates a
 * `seq` for every connector call and every `codemode.step` in the order they
 * happen, and threads `executionId` + `seq` to the facet. The facet keeps no
 * in-memory cursor, so runs are safe across hibernation and can run
 * concurrently without clobbering one another.
 */
import { RpcTarget } from "cloudflare:workers";
import { tool, type Tool } from "ai";
import { z } from "zod";
import type { Executor, ResolvedProvider, ConnectorBinding } from "./executor";
import { runCode } from "./run-code";
import { normalizeCode } from "./normalize";
import type { CodemodeConnector, ConnectorDescription } from "./connectors";
import type {
  ExecutionEndStatus,
  PassEndStatus,
  ToolAnnotations
} from "./connectors";
import { searchConnectors, describeTarget } from "./connectors";
import {
  CodemodeRuntime,
  MAX_DURABLE_VALUE_BYTES,
  STEP_CONNECTOR,
  tooLargeMessage,
  type BeginOptions,
  type PendingAction,
  type ToolDecision,
  type ToolLogEntry,
  type ExecutionState
} from "./runtime";
import type { Snippet, SaveSnippetOptions } from "./snippet";
import type { CodeOutput } from "./shared";

// Connector annotations, flattened to "connector.method" → annotation.
type AnnotationMap = Record<string, ToolAnnotations>;

/**
 * The RPC surface of the CodemodeRuntime facet, as the proxy tool uses it.
 *
 * Declared explicitly rather than relying on `Fetcher<CodemodeRuntime>`: the
 * RPC type transform collapses discriminated unions like `ToolDecision`
 * (the `unknown` payload doesn't survive serialization inference), which would
 * break `decision.kind` narrowing. This interface keeps the domain types intact.
 */
interface RuntimeStub {
  begin(code: string, options?: BeginOptions): Promise<string>;
  resume(id: string): Promise<ExecutionState | null>;
  decide(
    executionId: string,
    seq: number,
    connector: string,
    method: string,
    args: unknown,
    requiresApproval: boolean,
    ephemeral?: boolean
  ): Promise<ToolDecision>;
  recordResult(
    executionId: string,
    seq: number,
    result: unknown
  ): Promise<void>;
  complete(
    executionId: string,
    result: unknown,
    logs?: string[]
  ): Promise<void>;
  fail(executionId: string, error: string, logs?: string[]): Promise<void>;
  listPending(executionId?: string): Promise<PendingAction[]>;
  reject(seq: number, executionId: string): Promise<boolean>;
  expirePaused(maxAgeMs?: number): Promise<string[]>;
  actionsToRevert(executionId: string): Promise<ToolLogEntry[]>;
  markReverted(seq: number, executionId: string): Promise<void>;
  markRolledBack(executionId: string): Promise<void>;
  getExecution(id: string): Promise<ExecutionState | null>;
  listExecutions(limit?: number): Promise<ExecutionState[]>;
  deleteExecution(id: string): Promise<boolean>;
  pruneExecutions(keep?: number): Promise<number>;
  saveSnippet(name: string, options: SaveSnippetOptions): Promise<Snippet>;
  getSnippet(name: string): Promise<Snippet | null>;
  listSnippets(): Promise<Snippet[]>;
  deleteSnippet(name: string): Promise<boolean>;
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type ProxyToolInput = { code: string };

export type ProxyToolOutput =
  | {
      status: "completed";
      executionId: string;
      result: unknown;
      logs?: string[];
    }
  | {
      status: "paused";
      executionId: string;
      pending: PendingAction[];
    }
  // Execution errors (a thrown sandbox error or a replay divergence) are
  // returned, not thrown: the model sees the failure as a tool result it can
  // reason about, and the agent loop isn't broken by an exception. The failure
  // is also recorded on the execution (status "error") for the audit trail.
  | {
      status: "error";
      executionId: string;
      error: string;
      logs?: string[];
    };

/**
 * Shape the final result before it is returned to the model. Runs on a
 * completed run only (not on pause/error), after the raw result is recorded on
 * the execution — so the audit trail keeps the full value while the model sees
 * the transformed one. A common use is `truncateResult` to cap response size.
 */
export type TransformResult = (result: unknown) => unknown | Promise<unknown>;

export type CreateProxyToolOptions = {
  ctx: DurableObjectState;
  connectors: CodemodeConnector[];
  executor: Executor;
  /**
   * Runtime name — the durable identity of this runtime's facet (executions,
   * snippets). Defaults to `"default"`. Use distinct names for runtimes that
   * should not share history. Adding or removing connectors does NOT change
   * the identity: each execution/snippet records the connector names it needs,
   * and resuming/re-running verifies they are still configured.
   */
  name?: string;
  description?: string;
  /**
   * One-line hints rendered next to each connector in the default tool
   * description (keyed by connector name). Use them to tell the model what a
   * namespace is for — e.g. `{ state: "the workspace filesystem" }` — without
   * it having to run a `codemode.search` discovery pass first. Ignored when a
   * custom `description` is given.
   */
  connectorHints?: Record<string, string>;
  /** Terminal executions retained per runtime. Defaults to 50. */
  maxExecutions?: number;
  /** Optionally reshape the model-facing result (e.g. truncate). */
  transformResult?: TransformResult;
};

// ---------------------------------------------------------------------------
// Schema + pause sentinel
// ---------------------------------------------------------------------------

const proxySchema = z.object({ code: z.string() });

// Sandbox-side marker thrown to abort the run on a pause. The proxy tool
// detects the pause via the facet's recorded state, not this message.
const PAUSE_SENTINEL = "__CODEMODE_PAUSE__";

// Sandbox-side definition of `codemode.step(name, fn)`. Assigned as an own
// property on the codemode namespace so it shadows the dispatch proxy. It
// wraps the local closure: ask the host whether to replay (return recorded
// value) or execute (run fn, record the result). This is the explicit
// side-effect boundary that makes replay correct for arbitrary work.
const STEP_PRELUDE = String.raw`
    codemode.step = async (name, fn) => {
      const decision = await codemode.__stepDecide(name);
      if (decision.kind === "replay") return decision.result;
      // Anything other than "execute" (i.e. a pause from divergence) aborts
      // the run; the reason is recorded on the execution.
      if (decision.kind !== "execute") throw new Error("${PAUSE_SENTINEL}");
      const value = await fn();
      await codemode.__stepRecord(decision.seq, value);
      return value;
    };`;

// Connector bindings return a control marker — `{ [CONTROL_KEY]: "pause" }` or
// `{ [CONTROL_KEY]: "error", message }` — rather than throwing across RPC. The
// sandbox connector proxy (see executor.ts CONNECTOR_CONTROL_KEY) detects it and
// throws locally. Keep these two in sync.
const CONTROL_KEY = "__codemode_control__";

// ---------------------------------------------------------------------------
// Host-side replay cursor — allocates seq per call/step, in order.
// ---------------------------------------------------------------------------

type Cursor = { next(): number };

function createCursor(): Cursor {
  let n = 0;
  return { next: () => n++ };
}

// ---------------------------------------------------------------------------
// Connector binding — an RpcTarget the sandbox calls via Workers RPC.
//
// Live RPC references can only be serialized as RPC call arguments (not via
// Worker env), and a plain object with a function property can't be cloned at
// all — so the binding MUST be an RpcTarget passed as an evaluate() argument.
// ---------------------------------------------------------------------------

class ConnectorCallTarget extends RpcTarget {
  #handle: (method: string, args: unknown) => Promise<unknown>;
  constructor(handle: (method: string, args: unknown) => Promise<unknown>) {
    super();
    this.#handle = handle;
  }
  callTool(method: string, args: unknown): Promise<unknown> {
    return this.#handle(method, args);
  }
}

// ---------------------------------------------------------------------------
// Setup — connectors + runtime facet
// ---------------------------------------------------------------------------

type Setup = {
  connectorsByName: Map<string, CodemodeConnector>;
  descriptions: ConnectorDescription[];
  annotations: AnnotationMap;
};

async function loadSetup(connectors: CodemodeConnector[]): Promise<Setup> {
  const connectorsByName = new Map<string, CodemodeConnector>();
  const descriptions: ConnectorDescription[] = [];
  const annotations: AnnotationMap = {};

  for (const connector of connectors) {
    const name = connector.name();
    const description = await connector.describe();
    connectorsByName.set(name, connector);
    descriptions.push(description);
    for (const [method, annotation] of Object.entries(
      description.annotations ?? {}
    )) {
      annotations[`${name}.${method}`] = annotation;
    }
  }

  return { connectorsByName, descriptions, annotations };
}

// ---------------------------------------------------------------------------
// Execution teardown — fire the connector lifecycle hook on a terminal status
// ---------------------------------------------------------------------------

/**
 * Notify every connector that an execution reached a terminal state so it can
 * dispose any per-execution resource (e.g. a browser session). Deliberately
 * *not* called on pause — a paused run may resume later. Hook rejections are
 * swallowed: teardown must never turn a finished run into a failure.
 *
 * Fires for every connector regardless of whether it took part in the run —
 * connectors that own no per-execution state default to a no-op.
 */
export async function disposeConnectors(
  connectors: Iterable<CodemodeConnector>,
  executionId: string,
  status: ExecutionEndStatus
): Promise<void> {
  await Promise.all(
    [...connectors].map(async (connector) => {
      try {
        await connector.disposeExecution(executionId, status);
      } catch {
        // Intentionally ignored — see doc comment.
      }
    })
  );
}

/**
 * Notify every connector that an execution pass ended — including a pause,
 * where `disposeExecution` deliberately does not fire — so per-pass resources
 * (open sockets, leases) can be released. Rejections are swallowed for the
 * same reason as `disposeConnectors`.
 */
async function notifyPassEnd(
  connectors: Iterable<CodemodeConnector>,
  executionId: string,
  status: PassEndStatus
): Promise<void> {
  await Promise.all(
    [...connectors].map(async (connector) => {
      try {
        await connector.onPassEnd(executionId, status);
      } catch {
        // Intentionally ignored — see doc comment.
      }
    })
  );
}

/**
 * Reject reserved and duplicate connector namespaces up front. Duplicates
 * would silently shadow each other in the sandbox (last one wins).
 */
export function validateConnectorNames(
  connectors: Iterable<CodemodeConnector>
): void {
  const seen = new Set<string>();
  for (const connector of connectors) {
    const name = connector.name();
    if (name === "codemode") {
      throw new Error(
        'Connector name "codemode" is reserved for the codemode platform SDK.'
      );
    }
    if (seen.has(name)) {
      throw new Error(
        `Duplicate connector name "${name}" — each connector needs a unique ` +
          `namespace (pass a distinct \`name\` option).`
      );
    }
    seen.add(name);
  }
}

// ---------------------------------------------------------------------------
// Connector bindings — every call routes through the runtime for a decision
// ---------------------------------------------------------------------------

function buildConnectorBindings(
  setup: Setup,
  runtime: RuntimeStub,
  executionId: string,
  cursor: Cursor
): ConnectorBinding[] {
  return setup.descriptions.map((desc) => ({
    name: desc.name,
    binding: new ConnectorCallTarget(async (method, args) => {
      // The RpcTarget method must ALWAYS resolve — never reject. A rejection
      // across the sandbox→host RPC boundary is tracked as an unhandled
      // rejection on the host even though the sandbox awaits it. So every
      // outcome, including a genuine error, is returned as a value: a result, a
      // pause marker, or an error marker. The sandbox proxy turns the pause/
      // error markers into a local throw, which the run's own try/catch handles
      // (and which surfaces as an "error" execution exactly as a raw throw did).
      try {
        const seq = cursor.next();
        const annotation = setup.annotations[`${desc.name}.${method}`];
        const requiresApproval = annotation?.requiresApproval ?? false;
        const ephemeral = annotation?.replay === "reexecute";
        const decision = await runtime.decide(
          executionId,
          seq,
          desc.name,
          method,
          args,
          requiresApproval,
          ephemeral
        );

        if (decision.kind === "replay") return decision.result;
        if (decision.kind === "pause") return { [CONTROL_KEY]: "pause" };

        const connector = setup.connectorsByName.get(desc.name);
        if (!connector) throw new Error(`Unknown connector: ${desc.name}`);
        const result = await connector.executeTool(method, args, {
          executionId
        });
        await runtime.recordResult(executionId, decision.seq, result);
        return result;
      } catch (err) {
        // Log the original error (with its stack) on the host: returning a
        // marker keeps the RPC call from rejecting, but a genuine failure still
        // deserves a host-side trace for debugging. The message also reaches the
        // model and the audit trail via the run's "error" outcome.
        console.error(
          `codemode: ${desc.name}.${method} failed (execution ${executionId})`,
          err
        );
        return {
          [CONTROL_KEY]: "error",
          message: err instanceof Error ? err.message : String(err)
        };
      }
    })
  }));
}

// ---------------------------------------------------------------------------
// Platform provider — codemode namespace
// ---------------------------------------------------------------------------

function createPlatformProvider(
  setup: Setup,
  bindings: ConnectorBinding[],
  runtime: RuntimeStub,
  executor: Executor,
  executionId: string,
  cursor: Cursor
): ResolvedProvider {
  const { descriptions } = setup;
  const provider: ResolvedProvider = {
    name: "codemode",
    prelude: STEP_PRELUDE,
    fns: {
      // Discovery
      search: async (query: unknown) =>
        searchConnectors(
          String(query),
          descriptions,
          await runtime.listSnippets()
        ),

      describe: async (target: unknown) =>
        describeTarget(
          String(target),
          descriptions,
          await runtime.listSnippets()
        ),

      // Snippets — durable saved scripts the developer promoted
      run: async (...args: unknown[]) => {
        const snippet = await runtime.getSnippet(String(args[0]));
        if (!snippet) return { error: `Snippet "${args[0]}" not found.` };
        // The snippet recorded the connectors its source execution ran with;
        // refuse with a clear error when one is no longer configured rather
        // than failing partway through the script.
        const missing = missingConnectors(
          snippet.connectors,
          new Set(setup.connectorsByName.keys())
        );
        if (missing.length > 0) {
          return {
            error:
              `Snippet "${args[0]}" requires connector(s) ` +
              `${missing.map((m) => `"${m}"`).join(", ")} that are not ` +
              `configured on this runtime.`
          };
        }
        // Snippets are saved execution code, so they may use the codemode
        // SDK (e.g. codemode.step) — run them with this same provider, which
        // shares the cursor so the snippet's calls continue this run's log.
        //
        // The stored snippet is the model's raw code, which may carry markdown
        // fences or be a statement block — embedding it directly as an
        // expression would be a syntax error. Normalize it to a valid arrow
        // expression first (the same transform the executor applies to a fresh
        // run); `runCode` then normalizes the outer wrapper as usual.
        const snippetExpr = normalizeCode(snippet.code);
        const result = await runCode({
          code: `async () => {\n  const snippet = (${snippetExpr});\n  return await snippet(${JSON.stringify(args[1])});\n}`,
          executor,
          providers: [provider],
          connectors: bindings
        });
        return result.result;
      },

      // Host primitives backing the codemode.step() prelude. The closure
      // can't cross the RPC boundary, so step decides + records here while the
      // sandbox runs the closure locally only when told to execute.
      __stepDecide: async (name: unknown) =>
        runtime.decide(
          executionId,
          cursor.next(),
          STEP_CONNECTOR,
          String(name),
          undefined,
          false
        ),

      __stepRecord: async (seq: unknown, value: unknown) => {
        await runtime.recordResult(executionId, Number(seq), value);
        return true;
      }
    }
  };
  return provider;
}

// ---------------------------------------------------------------------------
// Tool description
// ---------------------------------------------------------------------------

function buildDescription(
  connectors: CodemodeConnector[],
  customDescription?: string,
  connectorHints?: Record<string, string>
): string {
  if (customDescription) return customDescription;

  const namespaces = connectors
    .map((c) => {
      const name = c.name();
      const hint = connectorHints?.[name];
      return hint ? `- \`${name}\` — ${hint}` : `- \`${name}\``;
    })
    .join("\n");

  const names = connectors.map((c) => `\`${c.name()}\``).join(", ");

  const lines = [
    "Execute JavaScript in a sandbox with access to connector SDKs.",
    "",
    "## Workflow",
    "",
    '1. `const matches = await codemode.search("short intent phrase");`',
    "2. `const docs = await codemode.describe(matches.results[0].path);`",
    "3. Call the method: `await <connector>.<method>(args);`",
    "",
    "## Rules",
    "",
    `- The ONLY globals are ${names} and \`codemode\` (plus standard JavaScript). There is no \`host\`, \`fs\`, \`require\`, \`process\`, or Node.js API — all I/O goes through the connectors below.`,
    "- Never guess method names. If you have not used a connector in this conversation, run a discovery pass first: `codemode.search(query)` returns ranked matches across connector methods and saved snippets.",
    '- `codemode.describe("connector.method")` returns TypeScript type declarations.',
    "- `codemode.step(name, fn)` wraps side-effectful or nondeterministic work (raw fetch, random, time) so it runs once and is replayed on resume. Use it for anything that isn't a connector call.",
    "- Some methods require approval. The run pauses until the user approves, then resumes automatically. Write code as if the call returns normally.",
    '- A result with `status: "paused"` means the run is awaiting human approval. Tell the user what is pending and wait — do NOT re-issue the code; the run resumes on its own once approved.',
    "- All code outside connector calls and `codemode.step` must be deterministic so resume can replay it.",
    "- Do not use `fetch` — use connector SDKs.",
    "",
    "## Snippets",
    "",
    "Snippets are saved scripts you can reuse.",
    '- `codemode.run("name", input)` runs a saved snippet. Snippets appear in `codemode.search` results.',
    "- If a script may be saved as a snippet later, write it as `async (input) => { ... }` so it can take input.",
    "",
    "## Available connectors",
    "",
    namespaces
  ];

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Run one pass of the code through the executor.
// ---------------------------------------------------------------------------

async function runPass(
  executionId: string,
  code: string,
  setup: Setup,
  runtime: RuntimeStub,
  executor: Executor,
  transformResult?: TransformResult
): Promise<ProxyToolOutput> {
  const cursor = createCursor();
  const bindings = buildConnectorBindings(setup, runtime, executionId, cursor);
  const platformProvider = createPlatformProvider(
    setup,
    bindings,
    runtime,
    executor,
    executionId,
    cursor
  );

  const connectors = [...setup.connectorsByName.values()];

  // Every pass — paused, completed, or errored — must end with onPassEnd so
  // connectors can release per-pass resources (sockets, leases). On terminal
  // outcomes, disposeExecution follows. `ended` makes the finally a safety net
  // for crashes inside this function itself (e.g. a facet RPC failure), not a
  // double-fire.
  let ended = false;
  const endPass = async (status: PassEndStatus) => {
    ended = true;
    await notifyPassEnd(connectors, executionId, status);
    if (status !== "paused") {
      await disposeConnectors(connectors, executionId, status);
    }
  };

  try {
    let output: CodeOutput | undefined;
    let threw: unknown;
    try {
      output = await runCode({
        code,
        executor,
        providers: [platformProvider],
        connectors: bindings
      });
    } catch (err) {
      threw = err;
    }

    // The facet status is the source of truth: a pause (approval or
    // divergence) records itself there before aborting the run. The
    // PAUSE_SENTINEL only stops the sandbox; it is never the deciding signal
    // here.
    const execution = await runtime.getExecution(executionId);
    if (execution?.status === "paused") {
      // Not terminal — the run may resume, so per-execution connector
      // resources stay open. Per-pass resources are still released.
      await endPass("paused");
      return {
        status: "paused",
        executionId,
        pending: await runtime.listPending(executionId)
      };
    }
    if (execution?.status === "error") {
      // A replay divergence (or an in-run durable-log failure), already
      // recorded on the execution by the facet.
      await endPass("error");
      return {
        status: "error",
        executionId,
        error: execution.error ?? "Codemode execution failed"
      };
    }

    if (threw) {
      const raw = threw instanceof Error ? threw.message : String(threw);
      const message = withGlobalsHint(raw, setup);
      await runtime.fail(executionId, message);
      await endPass("error");
      return { status: "error", executionId, error: message };
    }

    const result = output?.result;
    await runtime.complete(executionId, result, output?.logs);
    await endPass("completed");
    return {
      status: "completed",
      executionId,
      result: await applyTransform(transformResult, result),
      logs: output?.logs
    };
  } finally {
    if (!ended) {
      // Something inside runPass itself threw before any labeled exit — make
      // sure connectors still hear about the pass ending.
      await endPass("error");
    }
  }
}

/**
 * A sandbox `ReferenceError` usually means the model invented a global (e.g.
 * `host.writeFile(...)`). Append the real globals so the retry is informed
 * instead of another guess.
 */
function withGlobalsHint(message: string, setup: Setup): string {
  if (!/\bis not defined\b/.test(message)) return message;
  const names = [...setup.connectorsByName.keys(), "codemode"].join(", ");
  return `${message} (the only globals available in the sandbox are: ${names})`;
}

/**
 * Apply the result transform, defending against a buggy transform: the run has
 * already completed and its resources are disposed, so a throwing transform
 * must not turn a successful run into a thrown tool error. Fall back to the raw
 * result (and warn) instead.
 */
async function applyTransform(
  transformResult: TransformResult | undefined,
  result: unknown
): Promise<unknown> {
  if (!transformResult) return result;
  try {
    return await transformResult(result);
  } catch (err) {
    console.warn(
      "codemode: transformResult threw; returning the raw result.",
      err
    );
    return result;
  }
}

// ---------------------------------------------------------------------------
// createProxyTool
// ---------------------------------------------------------------------------

export function createProxyTool(
  options: CreateProxyToolOptions
): Tool<ProxyToolInput, ProxyToolOutput> {
  const connectors = options.connectors;
  validateConnectorNames(connectors);

  // Spawn the runtime facet on the agent DO, keyed by the runtime name. The
  // connector set is data, not identity: each execution/snippet records the
  // connector names it needs, and resume/snippet-run verifies they are still
  // configured — so a runtime can gain or lose connectors without forking its
  // history.
  const runtime = getRuntime(options.ctx, options.name);

  let setupPromise: Promise<Setup> | undefined;
  function getSetup() {
    return (setupPromise ??= loadSetup(connectors));
  }

  return tool({
    description: buildDescription(
      connectors,
      options.description,
      options.connectorHints
    ),
    inputSchema: proxySchema,
    execute: async ({ code }) => {
      // Validate size host-side (the facet's own guard would surface as a
      // cross-worker unhandled rejection) and return a model-actionable
      // tool result instead of breaking the agent loop.
      if (code.length > MAX_DURABLE_VALUE_BYTES) {
        return {
          status: "error",
          executionId: "",
          error: tooLargeMessage("The execution code", code.length)
        };
      }
      const setup = await getSetup();
      const executionId = await runtime.begin(code, {
        maxExecutions: options.maxExecutions,
        connectors: connectors.map((c) => c.name())
      });
      return runPass(
        executionId,
        code,
        setup,
        runtime,
        options.executor,
        options.transformResult
      );
    }
  });
}

// ---------------------------------------------------------------------------
// Shared facet handle
// ---------------------------------------------------------------------------

/** Default runtime name when none is given. */
const DEFAULT_RUNTIME_NAME = "default";

/**
 * The facet is keyed by an explicit runtime *name* (default `"default"`), not
 * by the connector set: a runtime keeps its executions and snippets when
 * connectors are added or removed. Staleness is handled as data instead —
 * every execution and snippet records the connector names it needs, and
 * resume/snippet-run verifies they are present, failing with a clear error
 * when one is missing.
 */
function runtimeFacetName(name = DEFAULT_RUNTIME_NAME): string {
  if (!/^[a-zA-Z0-9_.-]+$/.test(name)) {
    throw new Error(
      `Invalid codemode runtime name "${name}" — use letters, digits, ` +
        `"_", "-" or "."`
    );
  }
  return `codemode:${name}`;
}

// `ctx.facets` / `ctx.exports` are facet-runtime additions not yet in the
// public DurableObjectState types. The facet `class` must be the
// binding-backed value from `ctx.exports` (a directly-imported class reference
// is rejected by the runtime) — the consumer's worker must export the runtime
// class under the name `CodemodeRuntime` (the Vite plugin does this for you).
type FacetCapableCtx = DurableObjectState & {
  facets: {
    get<T>(name: string, init: () => { class: unknown; id?: unknown }): T;
  };
  exports?: Record<string, unknown>;
};

function getRuntime(ctx: DurableObjectState, name?: string): RuntimeStub {
  const facetCtx = ctx as unknown as FacetCapableCtx;
  const runtimeClass = facetCtx.exports?.CodemodeRuntime ?? CodemodeRuntime;
  return facetCtx.facets.get<RuntimeStub>(runtimeFacetName(name), () => ({
    class: runtimeClass
  }));
}

/** Internal: the runtime handle uses this to reach the facet. Not public API. */
export const getCodemodeRuntime = getRuntime;

// ---------------------------------------------------------------------------
// Resume — approve a pending action and continue via replay
// ---------------------------------------------------------------------------

export type ResumeCodemodeOptions = {
  ctx: DurableObjectState;
  connectors: CodemodeConnector[];
  executor: Executor;
  /** Runtime name (facet identity). Defaults to `"default"`. */
  name?: string;
  /** Execution id to resume. */
  executionId: string;
  maxExecutions?: number;
  /** Optionally reshape the model-facing result (e.g. truncate). */
  transformResult?: TransformResult;
};

/** Connectors an execution/snippet recorded but the runtime no longer has. */
function missingConnectors(
  required: string[] | undefined,
  available: Set<string>
): string[] {
  return (required ?? []).filter((name) => !available.has(name));
}

/**
 * Approve a pending action and continue the paused execution. Re-runs the
 * stored code; the runtime replays the log up to the approved action, runs it
 * for real, and proceeds to the next pause or completion.
 */
export async function resumeCodemode(
  options: ResumeCodemodeOptions
): Promise<ProxyToolOutput> {
  const runtime = getRuntime(options.ctx, options.name);

  const setup = await loadSetup(options.connectors);

  // The execution recorded the connector set it started with. Refuse to
  // resume when a required connector is no longer configured — replaying its
  // logged calls would fail confusingly partway through otherwise.
  const existing = await runtime.getExecution(options.executionId);
  if (existing) {
    const missing = missingConnectors(
      existing.connectors,
      new Set(setup.connectorsByName.keys())
    );
    if (missing.length > 0) {
      return {
        status: "error",
        executionId: options.executionId,
        error:
          `Execution "${options.executionId}" requires connector(s) ` +
          `${missing.map((m) => `"${m}"`).join(", ")} that are not ` +
          `configured on this runtime.`
      };
    }
  }

  const execution = await runtime.resume(options.executionId);
  if (!execution) {
    // resume() returns null both when the run is missing and when it isn't
    // paused. Distinguish the two so a caller can't silently revive a terminal
    // run (which would re-offer rejected actions or re-apply rolled-back work).
    // Surface this as an error *outcome* (not a throw) to match the divergence/
    // pause paths — the agent loop stays unbroken and nothing is re-executed.
    const error = existing
      ? `Execution "${options.executionId}" is not paused (status: ` +
        `${existing.status}); only a paused run can be approved.`
      : `No execution "${options.executionId}" to resume.`;
    return { status: "error", executionId: options.executionId, error };
  }

  return runPass(
    execution.id,
    execution.code,
    setup,
    runtime,
    options.executor,
    options.transformResult
  );
}

// ---------------------------------------------------------------------------
// Reject — reject a pending action, ending the execution
// ---------------------------------------------------------------------------

/**
 * Returns whether the reject actually terminated the run — `false` when the
 * seq was no longer pending (already approved, rejected elsewhere, or
 * expired). Callers MUST check this before reporting the run as rejected:
 * approve and reject can interleave across the facet RPC await, and a no-op
 * reject means the action may have executed.
 */
export async function rejectCodemode(options: {
  ctx: DurableObjectState;
  connectors: CodemodeConnector[];
  name?: string;
  seq: number;
  executionId: string;
}): Promise<boolean> {
  const terminated = await getRuntime(options.ctx, options.name).reject(
    options.seq,
    options.executionId
  );
  // Only dispose if the reject actually ended the run. A stale/duplicate reject
  // (seq no longer pending) is a no-op, and the run may still be live and
  // resumable — tearing its resources down would break the next resume.
  if (terminated) {
    await disposeConnectors(
      options.connectors,
      options.executionId,
      "rejected"
    );
  }
  return terminated;
}

// ---------------------------------------------------------------------------
// Pending — list actions awaiting approval, for approval UIs
// ---------------------------------------------------------------------------

export async function pendingCodemode(options: {
  ctx: DurableObjectState;
  name?: string;
  executionId?: string;
}): Promise<PendingAction[]> {
  return getRuntime(options.ctx, options.name).listPending(options.executionId);
}

// ---------------------------------------------------------------------------
// Expiry — reclaim paused runs nobody ever approved
// ---------------------------------------------------------------------------

/**
 * Expire paused (awaiting-approval) executions idle past `maxAgeMs`, marking
 * them rejected and firing each connector's `disposeExecution` so
 * per-execution resources (e.g. browser sessions) are reclaimed. Paused runs
 * are deliberately exempt from retention pruning, so without this a
 * never-answered approval would live forever. Returns the expired ids.
 * Designed to be called from a recurring alarm/scheduled task.
 */
export async function expireCodemode(options: {
  ctx: DurableObjectState;
  connectors: CodemodeConnector[];
  name?: string;
  /** Expire paused runs whose last state change is older than this. */
  maxAgeMs?: number;
}): Promise<string[]> {
  const expired = await getRuntime(options.ctx, options.name).expirePaused(
    options.maxAgeMs
  );
  for (const executionId of expired) {
    await disposeConnectors(options.connectors, executionId, "rejected");
  }
  return expired;
}

// ---------------------------------------------------------------------------
// Rollback — revert applied actions in reverse order
// ---------------------------------------------------------------------------

export async function rollbackCodemode(options: {
  ctx: DurableObjectState;
  connectors: CodemodeConnector[];
  name?: string;
  executionId: string;
}): Promise<void> {
  const runtime = getRuntime(options.ctx, options.name);

  const byName = new Map(options.connectors.map((c) => [c.name(), c]));
  const actions = await runtime.actionsToRevert(options.executionId);

  // Attempt every revert, in reverse order, even if some fail — a failing
  // compensation must not strand the actions after it as un-reverted. Failures
  // are collected and surfaced after the whole pass rather than aborting it.
  let reverted = 0;
  const failures: string[] = [];
  for (const action of actions) {
    const connector = byName.get(action.connector);
    if (!connector) continue;
    try {
      // revertAction no-ops (returns false) for reads / tools without a revert.
      const didRevert = await connector.revertAction(
        action.method,
        action.args,
        action.result,
        { executionId: options.executionId }
      );
      if (didRevert) {
        await runtime.markReverted(action.seq, options.executionId);
        reverted++;
      }
    } catch (err) {
      failures.push(
        `${action.connector}.${action.method}: ` +
          (err instanceof Error ? err.message : String(err))
      );
    }
  }

  // Reflect the rollback in the execution status so the audit trail doesn't
  // keep showing "completed" after the run's effects were undone.
  if (reverted > 0) {
    await runtime.markRolledBack(options.executionId);
    // Rolling back is terminal — dispose per-execution connector resources.
    await disposeConnectors(
      options.connectors,
      options.executionId,
      "rolled_back"
    );
  }

  if (failures.length > 0) {
    throw new Error(
      `Rollback reverted ${reverted} action(s) but ${failures.length} failed: ` +
        failures.join("; ")
    );
  }
}
