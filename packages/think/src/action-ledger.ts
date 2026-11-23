/**
 * The action ledger and durable-pause decisions as Task runs. Nothing here
 * stores anything of its own: an effect is a run of `EFFECT_TASK` under the
 * effect's key, and a decision is a run of `DECISION_TASK` that parks until
 * `approveExecution` / `rejectExecution` settles it from outside.
 *
 * @internal
 */

import { tableExists } from "./config-store";
import type { TaskJson, TaskValue, Tasks } from "agents/tasks";
import { TaskSettlement, type TaskRecord } from "agents/internal";

/** Run definition of one side effect, run once per key. */
export const EFFECT_TASK = "__cf_think_action_effect";
/** Run definition of one durable-pause decision. */
export const DECISION_TASK = "__cf_think_action_decision";

/** A value past this many characters is not recorded (SQLite row limit). */
const MAX_RECORDED_CHARS = 1_000_000;

/**
 * A stable string form of a value: object keys sorted, so two objects with
 * the same entries in another order give the same string. A `Date` is
 * written as its ISO time.
 */
export function stableStringify(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value instanceof Date) {
    return `Date(${Number.isNaN(value.getTime()) ? "Invalid" : value.toISOString()})`;
  }
  if (typeof value === "function" || typeof value === "symbol") {
    return String(value);
  }
  if (value === null || typeof value !== "object") {
    if (typeof value === "bigint") return `${value.toString()}n`;
    return JSON.stringify(value) ?? "undefined";
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
}

/**
 * A 128-bit hash of {@link stableStringify}: tells inputs apart, hides
 * nothing. The function Think's action ledger always used, so rows an older
 * version wrote still match.
 */
export function stableHash(value: unknown): string {
  const input = stableStringify(value);
  let h1 = 1779033703;
  let h2 = 3144134277;
  let h3 = 1013904242;
  let h4 = 2773480762;
  for (let i = 0; i < input.length; i++) {
    const code = input.charCodeAt(i);
    h1 = h2 ^ Math.imul(h1 ^ code, 597399067);
    h2 = h3 ^ Math.imul(h2 ^ code, 2869860233);
    h3 = h4 ^ Math.imul(h3 ^ code, 951274213);
    h4 = h1 ^ Math.imul(h4 ^ code, 2716044179);
  }
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
  return [h1, h2, h3, h4]
    .map((part) => (part >>> 0).toString(16).padStart(8, "0"))
    .join("");
}

/** What {@link runEffectOnce} did. */
export type EffectOutcome =
  /** This call ran the effect and recorded its value. */
  | { status: "ran"; value: unknown }
  /** The value was recorded earlier; the effect did not run. */
  | { status: "replayed"; value: unknown }
  /** A stale claim was taken over and the effect ran again. */
  | { status: "reclaimed"; value: unknown; ageMs: number }
  /** An earlier attempt claimed the key and never finished. Nothing ran. */
  | { status: "in-doubt"; ageMs: number }
  /** The key was used with another name or input. Nothing ran. */
  | { status: "conflict" }
  /** The effect ran but its value cannot be recorded; a later call runs it again. */
  | { status: "unrecorded"; value: unknown };

type EffectInput = { name: string; inputHash: string };

/** What a running effect carries in this isolate. */
type Running = {
  name: string;
  inputHash: string;
  promise: Promise<EffectOutcome>;
};

/** In-memory companion of the effect runs in flight in this isolate. */
export type EffectState = {
  readonly running: Map<string, Running>;
  /** A value the run could not record, or what `run` threw, by run id. */
  readonly unrecorded: Map<string, { value: unknown } | { thrown: unknown }>;
};

export function createEffectState(): EffectState {
  return { running: new Map(), unrecorded: new Map() };
}

/** The run id of an effect key. */
export function effectRunId(key: string): string {
  return `effect:${key}`;
}

/**
 * Register the effect definition. Attempt 1 runs the effect the caller passed
 * as `local`. A later attempt (a reset cut the first off) has no effect to
 * run and parks the run as `in-doubt`: whether the effect happened is
 * unknown, and the next caller decides.
 */
export function registerEffectTask(tasks: Tasks, state: EffectState): void {
  tasks.register(
    EFFECT_TASK,
    async (_input, step) => {
      const run = step.local as (() => Promise<unknown>) | undefined;
      if (!run) return TaskSettlement.park("in-doubt");
      let value: unknown;
      try {
        value = await run();
      } catch (thrown) {
        state.unrecorded.set(step.id, { thrown });
        return TaskSettlement.failed(thrown);
      }
      let json: string | undefined;
      try {
        json = JSON.stringify(value);
      } catch {
        json = undefined;
      }
      if (
        (value !== undefined && json === undefined) ||
        (json !== undefined && json.length > MAX_RECORDED_CHARS)
      ) {
        state.unrecorded.set(step.id, { value });
        return TaskSettlement.skipped("unrecorded");
      }
      return (json === undefined ? null : JSON.parse(json)) as TaskValue;
    },
    { attached: true }
  );
}

/**
 * Run `run` once for `key` and record its value as the run's result. A
 * later call with the same key, name and input returns the recorded value.
 * A call while this isolate runs the key shares that run. A claim a reset
 * left answers `in-doubt` and runs nothing, unless `reclaimAfterMs` allows
 * taking it over. If `run` throws, the run is deleted and the error
 * rethrown, so a later call runs again.
 */
export async function runEffectOnce(
  tasks: Tasks,
  state: EffectState,
  options: {
    key: string;
    name: string;
    input: unknown;
    run: () => Promise<unknown>;
    reclaimAfterMs: number | false;
  }
): Promise<EffectOutcome> {
  const runId = effectRunId(options.key);
  const inputHash = stableHash(options.input);
  const live = state.running.get(runId);
  if (live) {
    if (live.name !== options.name || live.inputHash !== inputHash) {
      return { status: "conflict" };
    }
    return live.promise;
  }
  let reclaimedAge: number | undefined;
  const existing = tasks.peek(runId);
  if (existing) {
    const stored = tasks.inputOf<EffectInput>(runId);
    if (stored?.name !== options.name || stored.inputHash !== inputHash) {
      return { status: "conflict" };
    }
    if (existing.status === "completed") {
      return { status: "replayed", value: existing.result };
    }
    if (existing.status === "pending" || existing.status === "running") {
      const ageMs = Date.now() - existing.createdAt;
      const lease = options.reclaimAfterMs;
      if (lease === false || ageMs <= lease) {
        return { status: "in-doubt", ageMs };
      }
      reclaimedAge = ageMs;
    }
  }
  // Registered before the first await, so a same-isolate caller shares it.
  const promise = (async (): Promise<EffectOutcome> => {
    try {
      if (reclaimedAge !== undefined) {
        await tasks.settle(runId, TaskSettlement.aborted("reclaimed"));
      }
      // An ended run that recorded nothing frees the key.
      if (existing) tasks.deleteRun(runId);
      await tasks.run(
        EFFECT_TASK,
        { name: options.name, inputHash } satisfies EffectInput,
        { runId, start: "now", local: options.run }
      );
      const record = tasks.peek(runId);
      const kept = state.unrecorded.get(runId);
      if (record?.status === "completed") {
        return reclaimedAge === undefined
          ? { status: "ran", value: record.result }
          : { status: "reclaimed", value: record.result, ageMs: reclaimedAge };
      }
      // Failed or unrecordable: the key is free again.
      tasks.deleteRun(runId);
      if (kept && "thrown" in kept) throw kept.thrown;
      if (kept && "value" in kept) {
        return { status: "unrecorded", value: kept.value };
      }
      throw new Error(`Effect "${options.key}" ended ${record?.status}`);
    } finally {
      state.unrecorded.delete(runId);
    }
  })();
  state.running.set(runId, { name: options.name, inputHash, promise });
  try {
    return await promise;
  } finally {
    state.running.delete(runId);
  }
}

/**
 * Delete recorded effects settled before `settledBefore`, and effects left
 * in doubt (a reset cut them off) created before `pendingBefore`.
 */
export async function sweepEffects(
  tasks: Tasks,
  options: {
    settledBefore: number | null;
    pendingBefore: number | null;
    limit: number;
  }
): Promise<{ settled: number; pending: number }> {
  const settled =
    options.settledBefore === null || options.limit <= 0
      ? 0
      : await tasks.delete({
          definition: EFFECT_TASK,
          status: ["completed"],
          settledBefore: new Date(options.settledBefore),
          limit: options.limit
        });
  let pending = 0;
  if (options.pendingBefore !== null && options.limit > settled) {
    for (const record of tasks.peekList({
      definition: EFFECT_TASK,
      status: ["pending", "running"],
      order: "oldest",
      limit: options.limit - settled
    })) {
      if (record.createdAt >= options.pendingBefore) break;
      await tasks.settle(record.runId, TaskSettlement.aborted("expired"));
      if (tasks.deleteRun(record.runId)) pending += 1;
    }
  }
  return { settled, pending };
}

/** What a decision run starts with. */
export type DecisionInput =
  /** A durable-pause action parked for approval. */
  | {
      kind: "action";
      action: string;
      toolCallId: string;
      requestId: string | null;
      input: TaskJson;
    }
  /** A codemode execution its runtime already decided: only the outcome is recorded. */
  | {
      kind: "codemode";
      executionId: string;
      verdict: TaskJson;
      output: TaskJson;
    };

/** A verdict as the decision run's result. */
export type DecisionVerdict = {
  approved: boolean;
  reason?: string;
  autoContinue?: boolean;
  connectionId?: string;
};

/**
 * Register the decision definition. An action decision parks at once until
 * `settle()` ends it with its verdict; a codemode one completes at once with
 * its recorded outcome. `onSettled` runs for a completed decision, at least
 * once: a reset before it returns runs it again.
 */
export function registerDecisionTask(
  tasks: Tasks,
  onSettled: (runId: string) => Promise<void>
): void {
  tasks.register(
    DECISION_TASK,
    (input) => {
      const decision = input as DecisionInput;
      if (decision.kind === "codemode") {
        return { verdict: decision.verdict, output: decision.output };
      }
      return TaskSettlement.park("decision");
    },
    {
      attached: true,
      reportWake: true,
      onStatus: async (snapshot) => {
        if (snapshot.status === "completed") await onSettled(snapshot.runId);
      }
    }
  );
}

/** Park a durable-pause action for a decision. */
export async function parkDecision(
  tasks: Tasks,
  options: { id: string; input: DecisionInput; descriptor?: TaskJson }
): Promise<void> {
  await tasks.run(DECISION_TASK, options.input, {
    runId: options.id,
    start: "now",
    ...(options.descriptor !== undefined && {
      metadata: { descriptor: options.descriptor }
    })
  });
}

/** Whether `record` is a decision still waiting for its verdict. */
export function isPendingDecision(record: TaskRecord | undefined): boolean {
  return (
    record?.definition === DECISION_TASK &&
    record.status === "pending" &&
    record.waitReason === "park"
  );
}

/** The decisions still waiting for a verdict, oldest first. */
export function pendingDecisions(tasks: Tasks): TaskRecord[] {
  return tasks
    .peekList({
      definition: DECISION_TASK,
      status: ["pending"],
      order: "oldest"
    })
    .filter(isPendingDecision);
}

/** Expire decisions nobody made, created before `before`. */
export async function sweepDecisions(
  tasks: Tasks,
  before: number,
  limit: number
): Promise<number> {
  let swept = 0;
  for (const record of pendingDecisions(tasks)) {
    if (swept >= limit || record.createdAt >= before) break;
    await tasks.settle(record.runId, TaskSettlement.aborted("expired"));
    if (tasks.deleteRun(record.runId)) swept += 1;
  }
  return swept;
}

/**
 * Move what an earlier Think version stored for actions into runs, one way,
 * then drop it:
 * - `cf_think_action_ledger` rows become effect runs. Keys, input hashes and
 *   recorded values keep their form, so a settled action still replays; an
 *   unsettled claim comes back in doubt.
 * - `cf_think_action_pending_approvals` rows are parked again under their
 *   ids, so they wait for a verdict at once (their TTL counts from now).
 * - `cf_think_deferred_resolved_pauses` entries become completed decisions
 *   carrying `resolvedPause`, which the next inference writes.
 *
 * @returns Whether deferred pauses were moved.
 */
export async function migrateLegacyActionRecords(
  storage: DurableObjectStorage,
  tasks: Tasks
): Promise<boolean> {
  if (tableExists(storage.sql, "cf_think_action_ledger")) {
    const rows = storage.sql
      .exec<{
        key: string;
        action_name: string;
        input_hash: string;
        status: "pending" | "settled";
        result_json: string | null;
        updated_at: number;
      }>(
        `SELECT key, action_name, input_hash, status, result_json, updated_at
         FROM cf_think_action_ledger`
      )
      .toArray();
    for (const row of rows) {
      const recorded = parseJson(row.result_json) as
        | { valuePresent?: boolean; value?: TaskJson }
        | undefined;
      await tasks.importRun({
        runId: effectRunId(row.key),
        definition: EFFECT_TASK,
        status: row.status === "settled" ? "completed" : "running",
        attempt: 1,
        input: { name: row.action_name, inputHash: row.input_hash },
        ...(row.status === "settled" && {
          result:
            recorded?.valuePresent === true ? (recorded.value ?? null) : null
        }),
        // The claim's age is what a reclaim measures.
        createdAt: row.updated_at,
        settledAt: row.updated_at
      });
    }
    storage.sql.exec("DROP TABLE cf_think_action_ledger");
    await storage.delete("cf_think_action_ledger:last_swept_at");
  }
  if (tableExists(storage.sql, "cf_think_action_pending_approvals")) {
    const rows = storage.sql
      .exec<{
        execution_id: string;
        action_name: string;
        tool_call_id: string;
        request_id: string | null;
        input_json: string;
        descriptor_json: string | null;
      }>(
        `SELECT execution_id, action_name, tool_call_id, request_id,
                input_json, descriptor_json
         FROM cf_think_action_pending_approvals`
      )
      .toArray();
    for (const row of rows) {
      await parkDecision(tasks, {
        id: row.execution_id,
        input: {
          kind: "action",
          action: row.action_name,
          toolCallId: row.tool_call_id,
          requestId: row.request_id,
          input: parseJson(row.input_json) ?? {}
        },
        descriptor: parseJson(row.descriptor_json)
      });
    }
    storage.sql.exec("DROP TABLE cf_think_action_pending_approvals");
    await storage.delete("cf_think_action_pending_approvals:last_swept_at");
  }
  const deferredKey = "cf_think_deferred_resolved_pauses";
  const deferred =
    await storage.get<
      Array<[string, { executionId: string; output: TaskJson }]>
    >(deferredKey);
  if (!deferred) return false;
  for (const [toolCallId, outcome] of deferred) {
    await tasks.importRun({
      runId: `migrated_${outcome.executionId}_${toolCallId}`,
      definition: DECISION_TASK,
      status: "completed",
      attempt: 1,
      metadata: {
        resolvedPause: {
          toolCallId,
          executionId: outcome.executionId,
          output: outcome.output
        }
      },
      createdAt: Date.now()
    });
  }
  await storage.delete(deferredKey);
  return true;
}

function parseJson(json: string | null): TaskJson | undefined {
  if (json === null) return undefined;
  try {
    return JSON.parse(json) as TaskJson;
  } catch {
    return undefined;
  }
}
