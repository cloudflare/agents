import { env } from "cloudflare:workers";
import { runDurableObjectAlarm } from "cloudflare:test";

export type HarnessSnapshot = {
  runId: string;
  status: string;
  revision: number;
  state?: Record<string, unknown>;
  result?: unknown;
  error?: { name: string; message: string };
  wait?: { type: string; key?: string; timeoutAt?: number };
  gates?: Array<{
    gateId: string;
    kind: string;
    state: string;
    expiresAt: number;
  }>;
  effects?: Array<{
    effectId: string;
    kind: string;
    recovery?: string;
    status: string;
  }>;
};

type RunEffectOptions = {
  value: string;
  kind?: string;
  recovery?: "safe" | "never" | "reconcile";
  timeoutMs?: number;
  retries?: {
    limit?: number;
    delay?: number;
    backoff?: "constant" | "linear" | "exponential";
  };
};

export type HarnessStub = DurableObjectStub & {
  start(label: string, runId?: string): Promise<{ runId: string }>;
  startWaiter(
    key: string,
    timeoutMs?: number,
    runId?: string
  ): Promise<{ runId: string }>;
  sendMessage(
    runId: string,
    key: string,
    value: string,
    eventId: string
  ): Promise<{ status: string; sequence?: number }>;
  sendMessageError(
    runId: string,
    key: string,
    value: string,
    eventId: string
  ): Promise<string | null>;
  startPermission(timeoutMs?: number): Promise<{ runId: string }>;
  startReplayGate(timeoutMs?: number): Promise<{ runId: string }>;
  startRevisitGate(timeoutMs?: number): Promise<{ runId: string }>;
  gateRowsFor(runId: string): Promise<Array<{ gate_id: string }>>;
  startGracefulCancel(key: string): Promise<{ runId: string }>;
  answerPermission(
    gateId: string,
    approved: boolean,
    eventId: string
  ): Promise<{ status: string }>;
  answerWrongPermissionKind(
    gateId: string,
    eventId: string
  ): Promise<{ status: string }>;
  withdrawPermission(gateId: string): Promise<boolean>;
  startEffect(
    value: string,
    recovery: "safe" | "never" | "reconcile",
    externalId?: string
  ): Promise<{ runId: string }>;
  startRunEffect(options: RunEffectOptions): Promise<{ runId: string }>;
  startMultiRun(): Promise<{ runId: string }>;
  startMixedRun(): Promise<{ runId: string }>;
  uncommittedEffectError(): Promise<string>;
  effectRowsFor(runId: string): Promise<
    Array<{
      effect_id: string;
      revision: number;
      status: string;
      attempt: number;
      retry_at: number | null;
    }>
  >;
  effectAttempts(key: string): Promise<number>;
  effectActivity(): Promise<{ runs: string[]; reconciles: string[] }>;
  seedEffectRecovery(
    value: string,
    recovery: "safe" | "never" | "reconcile",
    externalId?: string
  ): Promise<string>;
  seedReconcileTimeout(timeoutMs: number): Promise<string>;
  seedRunEffectRecovery(
    status: "running" | "completed",
    recovery: "safe" | "never"
  ): Promise<string>;
  sendRetryWake(
    runId: string,
    eventId: string
  ): Promise<{ status: string; sequence?: number }>;
  listRuns(options?: {
    definition?: string;
    status?: string | readonly string[];
    limit?: number;
  }): Promise<HarnessSnapshot[]>;
  listRunsQueryPlan(): Promise<string[]>;
  listRunsError(options?: {
    definition?: string;
    status?: string | readonly string[];
    limit?: number;
  }): Promise<string | null>;
  cancelRun(runId: string, reason?: string): Promise<{ status: string }>;
  pauseRun(runId: string): Promise<boolean>;
  resumeRun(runId: string): Promise<boolean>;
  deleteRun(runId: string): Promise<boolean>;
  migrateVersionOneRun(): Promise<{
    columns: string[];
    checkpoint: string | null;
  }>;
  migrateVersionThreeEffects(): Promise<{
    columns: string[];
    attempt: number;
    supportsRetrying: boolean;
  }>;
  runSnapshot(runId: string): Promise<HarnessSnapshot | null>;
};

export function createHarnessStub(): HarnessStub {
  return env.StateMachineHarnessObject.getByName(
    crypto.randomUUID()
  ) as unknown as HarnessStub;
}

export async function waitFor(
  stub: HarnessStub,
  runId: string,
  states: readonly string[],
  timeoutMs = 5_000
): Promise<HarnessSnapshot> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const snapshot = await stub.runSnapshot(runId);
    if (snapshot && states.includes(snapshot.status)) return snapshot;
    if (Date.now() > deadline) {
      throw new Error(
        `Machine ${runId} did not reach ${states.join("/")}; ` +
          `snapshot=${JSON.stringify(snapshot)}`
      );
    }
    await runDurableObjectAlarm(stub);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
