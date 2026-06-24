/** Internal durable execution orchestration for the Code Mode runtime. */
import { RpcTarget } from "cloudflare:workers";
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
  STEP_CONNECTOR,
  type BeginOptions,
  type PendingAction,
  type ToolDecision,
  type ToolLogEntry,
  type ExecutionState
} from "./runtime";
import type { Snippet, SaveSnippetOptions } from "./snippet";
import type { CodeOutput } from "./shared";
import type { ProxyToolOutput, TransformResult } from "./proxy-tool";
import {
  CodemodeExecutionError,
  isRetryableError,
  resolveRetryPolicy,
  type CodemodeRetryContext,
  type CodemodeRetryPolicy,
  type ExecuteFailure
} from "./retry";

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
export interface RuntimeStub {
  begin(code: string, options?: BeginOptions): Promise<string>;
  currentAttempt(id: string): Promise<number>;
  beginRetry(id: string, expectedAttempt: number): Promise<number | null>;
  resume(id: string): Promise<ExecutionState | null>;
  decide(
    executionId: string,
    seq: number,
    connector: string,
    method: string,
    args: unknown,
    requiresApproval: boolean,
    ephemeral: boolean,
    attempt: number
  ): Promise<ToolDecision>;
  recordResult(
    executionId: string,
    seq: number,
    result: unknown,
    attempt: number
  ): Promise<boolean>;
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
type PassControl = { failure?: ExecuteFailure };

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

export type Setup = {
  connectorsByName: Map<string, CodemodeConnector>;
  descriptions: ConnectorDescription[];
  annotations: AnnotationMap;
};

export async function loadSetup(
  connectors: CodemodeConnector[]
): Promise<Setup> {
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
  cursor: Cursor,
  attempt: number,
  control: PassControl,
  signal: AbortSignal
): ConnectorBinding[] {
  return setup.descriptions.map((desc) => ({
    name: desc.name,
    binding: new ConnectorCallTarget(async (method, args) => {
      // A caught retry signal must not let model code drive more effects in the
      // failed pass. Keep returning the same signal until the sandbox exits.
      if (control.failure) {
        return {
          [CONTROL_KEY]: "retryable",
          message: control.failure.message,
          retryAfterMs: control.failure.retryAfterMs
        };
      }

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
          ephemeral,
          attempt
        );

        if (decision.kind === "replay") return decision.result;
        if (decision.kind === "pause") return { [CONTROL_KEY]: "pause" };

        const connector = setup.connectorsByName.get(desc.name);
        if (!connector) throw new Error(`Unknown connector: ${desc.name}`);
        const result = await connector.executeTool(method, args, {
          executionId,
          signal
        });
        const recorded = await runtime.recordResult(
          executionId,
          decision.seq,
          result,
          decision.attempt
        );
        return recorded ? result : { [CONTROL_KEY]: "pause" };
      } catch (err) {
        if (isRetryableError(err)) {
          control.failure = {
            kind: "retryable",
            message: err.message,
            retryAfterMs: err.retryAfterMs
          };
          return {
            [CONTROL_KEY]: "retryable",
            message: err.message,
            retryAfterMs: err.retryAfterMs
          };
        }
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
  cursor: Cursor,
  attempt: number,
  control: PassControl
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
      __stepDecide: async (name: unknown) => {
        const seq = cursor.next();
        if (control.failure) return { kind: "pause" as const, seq };
        return runtime.decide(
          executionId,
          seq,
          STEP_CONNECTOR,
          String(name),
          undefined,
          false,
          false,
          attempt
        );
      },

      __stepRecord: async (seq: unknown, value: unknown) =>
        runtime.recordResult(executionId, Number(seq), value, attempt)
    }
  };
  return provider;
}

// ---------------------------------------------------------------------------
// Run one pass of the code through the executor.
// ---------------------------------------------------------------------------

export async function runPass(
  executionId: string,
  code: string,
  setup: Setup,
  runtime: RuntimeStub,
  executor: Executor,
  transformResult?: TransformResult,
  retry?: CodemodeRetryPolicy
): Promise<ProxyToolOutput> {
  const connectors = [...setup.connectorsByName.values()];
  try {
    return await runPasses(
      executionId,
      code,
      setup,
      runtime,
      executor,
      connectors,
      transformResult,
      retry
    );
  } catch (error) {
    // Facet RPCs and application retry callbacks can fail outside the sandbox.
    // Keep the model-facing contract data-only and make a best effort to leave
    // the execution terminal rather than stranded as "running".
    const message = error instanceof Error ? error.message : String(error);
    const logs =
      error instanceof CodemodeExecutionError ? error.logs : undefined;
    try {
      await runtime.fail(executionId, message, logs);
    } catch {
      // The facet itself may be unavailable; the original failure is clearer.
    }
    await notifyPassEnd(connectors, executionId, "error");
    await disposeConnectors(connectors, executionId, "error");
    return { status: "error", executionId, error: message, logs };
  }
}

async function runPasses(
  executionId: string,
  code: string,
  setup: Setup,
  runtime: RuntimeStub,
  executor: Executor,
  connectors: CodemodeConnector[],
  transformResult?: TransformResult,
  retry?: CodemodeRetryPolicy
): Promise<ProxyToolOutput> {
  const retryPolicy = resolveRetryPolicy(retry);
  let attempts = 0;

  while (true) {
    attempts++;
    const attempt = await runtime.currentAttempt(executionId);
    const cursor = createCursor();
    const control: PassControl = {};
    const abortController = new AbortController();
    const bindings = buildConnectorBindings(
      setup,
      runtime,
      executionId,
      cursor,
      attempt,
      control,
      abortController.signal
    );
    const platformProvider = createPlatformProvider(
      setup,
      bindings,
      runtime,
      executor,
      executionId,
      cursor,
      attempt,
      control
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
    } finally {
      // The sandbox pass no longer has a consumer for connector work. Abort
      // cooperatively before retry policy, lifecycle hooks, or disposal run.
      abortController.abort();
    }
    if (control.failure) {
      // The sandbox may catch the local retry marker. Host retry intent is
      // authoritative: discard that apparent success and restart the pass.
      // Preserve logs from either path: a caught marker returns output, while
      // an uncaught marker already carries logs on CodemodeExecutionError.
      const logs =
        output?.logs ??
        (threw instanceof CodemodeExecutionError ? threw.logs : undefined);
      threw = new CodemodeExecutionError(control.failure, logs);
    }

    // The facet status is the source of truth for pauses and in-run durable
    // failures. Retryable executor failures deliberately leave it running.
    const execution = await runtime.getExecution(executionId);
    if (execution?.status === "paused") {
      await notifyPassEnd(connectors, executionId, "paused");
      return {
        status: "paused",
        executionId,
        pending: await runtime.listPending(executionId)
      };
    }
    if (execution?.status === "error") {
      await notifyPassEnd(connectors, executionId, "error");
      await disposeConnectors(connectors, executionId, "error");
      return {
        status: "error",
        executionId,
        error: execution.error ?? "Codemode execution failed"
      };
    }

    if (threw) {
      const failure = failureFromThrown(threw);
      const snapshot = execution ?? (await runtime.getExecution(executionId));
      if (snapshot && attempts < retryPolicy.maxAttempts) {
        // Fence first: shouldRetry and delay are application callbacks and may
        // await. A timed-out sandbox must become stale before either runs.
        const nextAttempt = await runtime.beginRetry(executionId, attempt);
        if (nextAttempt !== null) {
          const context: CodemodeRetryContext = {
            executionId,
            attempt: attempts,
            failure,
            execution: snapshot
          };
          let shouldRetry: boolean;
          try {
            shouldRetry = await retryPolicy.shouldRetry(context);
          } catch (error) {
            throw executionCallbackError(error, threw);
          }
          if (shouldRetry) {
            await notifyPassEnd(connectors, executionId, "retrying");
            let delay: number;
            try {
              delay = await retryPolicy.delayMs(context);
            } catch (error) {
              throw executionCallbackError(error, threw);
            }
            if (delay > 0) await sleep(delay);
            continue;
          }
        }
      }

      const raw = threw instanceof Error ? threw.message : String(threw);
      const message = withGlobalsHint(raw, setup);
      const logs =
        threw instanceof CodemodeExecutionError ? threw.logs : undefined;
      await runtime.fail(executionId, message, logs);
      await notifyPassEnd(connectors, executionId, "error");
      await disposeConnectors(connectors, executionId, "error");
      return { status: "error", executionId, error: message, logs };
    }

    const result = output?.result;
    await runtime.complete(executionId, result, output?.logs);
    await notifyPassEnd(connectors, executionId, "completed");
    await disposeConnectors(connectors, executionId, "completed");
    return {
      status: "completed",
      executionId,
      result: await applyTransform(transformResult, result),
      logs: output?.logs
    };
  }
}

function executionCallbackError(
  error: unknown,
  executionError: unknown
): CodemodeExecutionError {
  return new CodemodeExecutionError(
    {
      kind: "error",
      message: error instanceof Error ? error.message : String(error)
    },
    executionError instanceof CodemodeExecutionError
      ? executionError.logs
      : undefined
  );
}

function failureFromThrown(error: unknown): ExecuteFailure {
  if (error instanceof CodemodeExecutionError) return error.failure;
  return {
    kind: "error",
    message: error instanceof Error ? error.message : String(error)
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

/** Connectors an execution/snippet recorded but the runtime no longer has. */
export function missingConnectors(
  required: string[] | undefined,
  available: Set<string>
): string[] {
  return (required ?? []).filter((name) => !available.has(name));
}
