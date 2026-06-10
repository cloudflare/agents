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
import type { ExecutionEndStatus, ToolAnnotations } from "./connectors";
import { searchConnectors, describeTarget } from "./connectors";
import {
  CodemodeRuntime,
  STEP_CONNECTOR,
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
  begin(code: string, maxExecutions?: number): Promise<string>;
  resume(id: string): Promise<ExecutionState | null>;
  decide(
    executionId: string,
    seq: number,
    connector: string,
    method: string,
    args: unknown,
    requiresApproval: boolean
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
  description?: string;
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
async function disposeConnectors(
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
        const requiresApproval =
          setup.annotations[`${desc.name}.${method}`]?.requiresApproval ??
          false;
        const decision = await runtime.decide(
          executionId,
          seq,
          desc.name,
          method,
          args,
          requiresApproval
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
  customDescription?: string
): string {
  if (customDescription) return customDescription;

  const namespaces = connectors.map((c) => `- \`${c.name()}\``).join("\n");

  const lines = [
    "Execute TypeScript in a sandbox with access to connector SDKs.",
    "",
    "## Workflow",
    "",
    '1. `const matches = await codemode.search("short intent phrase");`',
    "2. `const docs = await codemode.describe(matches.results[0].path);`",
    "3. Call the method: `await <connector>.<method>(args);`",
    "",
    "## Rules",
    "",
    "- `codemode.search(query)` returns ranked matches across connector methods and saved snippets.",
    '- `codemode.describe("connector.method")` returns TypeScript type declarations.',
    "- `codemode.step(name, fn)` wraps side-effectful or nondeterministic work (raw fetch, random, time) so it runs once and is replayed on resume. Use it for anything that isn't a connector call.",
    "- Some methods require approval. The run pauses until the user approves, then resumes automatically. Write code as if the call returns normally.",
    "- All code outside connector calls and `codemode.step` must be deterministic so resume can replay it.",
    "- Connector SDKs are available as globals named after each connector.",
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

  // The facet status is the source of truth: a pause (approval or divergence)
  // records itself there before aborting the run. The PAUSE_SENTINEL only stops
  // the sandbox; it is never the deciding signal here.
  const connectors = [...setup.connectorsByName.values()];

  const execution = await runtime.getExecution(executionId);
  if (execution?.status === "paused") {
    // Not terminal — the run may resume, so connector resources stay open.
    return {
      status: "paused",
      executionId,
      pending: await runtime.listPending(executionId)
    };
  }
  if (execution?.status === "error") {
    // A replay divergence, already recorded on the execution by the facet.
    await disposeConnectors(connectors, executionId, "error");
    return {
      status: "error",
      executionId,
      error: execution.error ?? "Codemode execution failed"
    };
  }

  if (threw) {
    const message = threw instanceof Error ? threw.message : String(threw);
    await runtime.fail(executionId, message);
    await disposeConnectors(connectors, executionId, "error");
    return { status: "error", executionId, error: message };
  }

  const result = output?.result;
  await runtime.complete(executionId, result, output?.logs);
  await disposeConnectors(connectors, executionId, "completed");
  return {
    status: "completed",
    executionId,
    result: await applyTransform(transformResult, result),
    logs: output?.logs
  };
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

  for (const connector of connectors) {
    if (connector.name() === "codemode") {
      throw new Error(
        'Connector name "codemode" is reserved for the codemode platform SDK.'
      );
    }
  }

  // Spawn the runtime facet on the agent DO. The facet's identity is derived
  // from the connector set, so changing connectors yields a different runtime
  // — which guarantees every snippet stored in a runtime only ever references
  // connectors that are present.
  const runtime = getRuntime(options.ctx, connectors);

  let setupPromise: Promise<Setup> | undefined;
  function getSetup() {
    return (setupPromise ??= loadSetup(connectors));
  }

  return tool({
    description: buildDescription(connectors, options.description),
    inputSchema: proxySchema,
    execute: async ({ code }) => {
      const setup = await getSetup();
      const executionId = await runtime.begin(code, options.maxExecutions);
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

/**
 * Fingerprint the connector set: sorted connector names. The runtime facet is
 * keyed by this, so a given runtime (and its saved snippets + paused
 * executions) is bound to exactly the connectors it was created with. Add,
 * remove, or rename a connector and you address a fresh runtime — stale
 * snippets that reference a now-absent connector can never surface.
 */
function runtimeFacetName(connectors: CodemodeConnector[]): string {
  const names = connectors
    .map((c) => c.name())
    .sort()
    .join(",");
  return `codemode:${names}`;
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

function getRuntime(
  ctx: DurableObjectState,
  connectors: CodemodeConnector[]
): RuntimeStub {
  const facetCtx = ctx as unknown as FacetCapableCtx;
  const runtimeClass = facetCtx.exports?.CodemodeRuntime ?? CodemodeRuntime;
  return facetCtx.facets.get<RuntimeStub>(runtimeFacetName(connectors), () => ({
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
  /** Execution id to resume. */
  executionId: string;
  maxExecutions?: number;
  /** Optionally reshape the model-facing result (e.g. truncate). */
  transformResult?: TransformResult;
};

/**
 * Approve a pending action and continue the paused execution. Re-runs the
 * stored code; the runtime replays the log up to the approved action, runs it
 * for real, and proceeds to the next pause or completion.
 */
export async function resumeCodemode(
  options: ResumeCodemodeOptions
): Promise<ProxyToolOutput> {
  const runtime = getRuntime(options.ctx, options.connectors);

  const setup = await loadSetup(options.connectors);

  const execution = await runtime.resume(options.executionId);
  if (!execution) {
    // resume() returns null both when the run is missing and when it isn't
    // paused. Distinguish the two so a caller can't silently revive a terminal
    // run (which would re-offer rejected actions or re-apply rolled-back work).
    // Surface this as an error *outcome* (not a throw) to match the divergence/
    // pause paths — the agent loop stays unbroken and nothing is re-executed.
    const existing = await runtime.getExecution(options.executionId);
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

export async function rejectCodemode(options: {
  ctx: DurableObjectState;
  connectors: CodemodeConnector[];
  seq: number;
  executionId: string;
}): Promise<void> {
  const terminated = await getRuntime(options.ctx, options.connectors).reject(
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
}

// ---------------------------------------------------------------------------
// Pending — list actions awaiting approval, for approval UIs
// ---------------------------------------------------------------------------

export async function pendingCodemode(options: {
  ctx: DurableObjectState;
  connectors: CodemodeConnector[];
  executionId?: string;
}): Promise<PendingAction[]> {
  return getRuntime(options.ctx, options.connectors).listPending(
    options.executionId
  );
}

// ---------------------------------------------------------------------------
// Rollback — revert applied actions in reverse order
// ---------------------------------------------------------------------------

export async function rollbackCodemode(options: {
  ctx: DurableObjectState;
  connectors: CodemodeConnector[];
  executionId: string;
}): Promise<void> {
  const runtime = getRuntime(options.ctx, options.connectors);

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
