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
import type { Executor } from "./executor";
import type { CodemodeConnector } from "./connectors";
import {
  CodemodeRuntime,
  MAX_DURABLE_VALUE_BYTES,
  tooLargeMessage,
  type PendingAction
} from "./runtime";
import {
  disposeConnectors,
  loadSetup,
  missingConnectors,
  runPass,
  validateConnectorNames,
  type RuntimeStub,
  type Setup
} from "./runtime-execution";
import type { CodemodeRetryPolicy } from "./retry";

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
  /** Durable retry policy. Explicit RetryableErrors retry by default. */
  retry?: CodemodeRetryPolicy;
};

// ---------------------------------------------------------------------------
// Schema + pause sentinel
// ---------------------------------------------------------------------------

type StandardSchemaIssue = {
  readonly message: string;
  readonly path?: ReadonlyArray<PropertyKey>;
};

type ProxyToolInputSchema = {
  readonly "~standard": {
    readonly version: 1;
    readonly vendor: "@cloudflare/codemode";
    readonly validate: (
      value: unknown
    ) =>
      | { readonly value: ProxyToolInput }
      | { readonly issues: ReadonlyArray<StandardSchemaIssue> };
    readonly jsonSchema: {
      readonly input: (options: {
        readonly target: string;
      }) => Record<string, unknown>;
      readonly output: (options: {
        readonly target: string;
      }) => Record<string, unknown>;
    };
  };
};

const proxyJsonSchema = {
  type: "object",
  properties: {
    code: { type: "string" }
  },
  required: ["code"],
  additionalProperties: false
};

const proxySchema: ProxyToolInputSchema = {
  "~standard": {
    version: 1,
    vendor: "@cloudflare/codemode",
    validate: (value) => {
      if (
        typeof value === "object" &&
        value !== null &&
        "code" in value &&
        typeof value.code === "string"
      ) {
        return { value: { code: value.code } };
      }

      return {
        issues: [{ message: "Expected an object with a string code property" }]
      };
    },
    jsonSchema: {
      input: (_options) => proxyJsonSchema,
      output: (_options) => proxyJsonSchema
    }
  }
};

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
// createProxyTool
// ---------------------------------------------------------------------------

export type CodemodeTool = {
  description: string;
  inputSchema: ProxyToolInputSchema;
  execute: (
    input: ProxyToolInput,
    options: unknown
  ) => Promise<ProxyToolOutput>;
};

export function createProxyTool(options: CreateProxyToolOptions): CodemodeTool {
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

  return {
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
        options.transformResult,
        options.retry
      );
    }
  };
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
  /** Durable retry policy for the resumed pass. */
  retry?: CodemodeRetryPolicy;
};

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
    options.transformResult,
    options.retry
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

  const abortController = new AbortController();
  try {
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
          { executionId: options.executionId, signal: abortController.signal }
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
  } finally {
    abortController.abort();
  }
}
