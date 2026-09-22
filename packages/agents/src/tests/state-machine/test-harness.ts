import { env } from "cloudflare:workers";
import { runDurableObjectAlarm } from "cloudflare:test";

export type HarnessSnapshot = {
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
  children?: Array<{
    runId: string;
    definition: string;
    mode: string;
    status: string;
  }>;
};

export type HarnessStub = DurableObjectStub & {
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
  effectActivity(): Promise<{ runs: string[]; reconciles: string[] }>;
  seedEffectRecovery(
    value: string,
    recovery: "safe" | "never" | "reconcile",
    externalId?: string
  ): Promise<string>;
  startParent(
    value: string,
    mode?: "attached" | "background"
  ): Promise<{ runId: string }>;
  cancelRun(runId: string, reason?: string): Promise<{ status: string }>;
  pauseRun(runId: string): Promise<boolean>;
  resumeRun(runId: string): Promise<boolean>;
  deleteRun(runId: string): Promise<boolean>;
  migrateVersionOneRun(): Promise<{
    columns: string[];
    checkpoint: string | null;
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
