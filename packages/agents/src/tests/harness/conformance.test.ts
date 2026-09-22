import { env } from "cloudflare:workers";
import { runDurableObjectAlarm } from "cloudflare:test";
import {
  runHarnessConformance,
  type ConformanceHarness,
  type ConformanceSnapshot
} from "./conformance";

type FixtureStub = DurableObjectStub & {
  harnessSubmit(
    key: string,
    options?: { idempotencyKey?: string }
  ): Promise<{ runId: string; accepted: boolean }>;
  harnessSend(
    runId: string,
    key: string,
    value: string,
    eventId: string
  ): Promise<unknown>;
  harnessInspect(runId: string): Promise<ConformanceSnapshot | null>;
  harnessAbort(runId: string, reason?: string): Promise<boolean>;
  harnessPause(runId: string): Promise<boolean>;
  harnessResume(runId: string): Promise<boolean>;
  harnessResult(runId: string): Promise<string | null>;

  wrappedSubmit(
    prompt: string,
    options?: { idempotencyKey?: string }
  ): Promise<{ runId: string; accepted: boolean }>;
  wrappedInspect(runId: string): Promise<ConformanceSnapshot | null>;
  wrappedAbort(runId: string, reason?: string): Promise<boolean>;
  wrappedResult(runId: string): Promise<string | null>;
  completeWrapped(runId: string, result: string): Promise<void>;
  wrappedRuntimeStatus(runId: string): Promise<string | null>;
};

function fixtureStub(): FixtureStub {
  return env.StateMachineHarnessObject.getByName(
    crypto.randomUUID()
  ) as unknown as FixtureStub;
}

function nativeHarness(): ConformanceHarness {
  const stub = fixtureStub();
  return {
    stub,
    submit: (key, options) => stub.harnessSubmit(key, options),
    settle: async (runId, key, value) => {
      await stub.harnessSend(runId, key, value, `event_${crypto.randomUUID()}`);
    },
    inspect: (runId) => stub.harnessInspect(runId),
    result: (runId) => stub.harnessResult(runId),
    abort: (runId, reason) => stub.harnessAbort(runId, reason),
    pause: (runId) => stub.harnessPause(runId),
    resume: (runId) => stub.harnessResume(runId)
  };
}

function wrappedHarness(): ConformanceHarness {
  const stub = fixtureStub();
  return {
    stub,
    submit: (key, options) => stub.wrappedSubmit(key, options),
    settle: async (runId, _key, value) => {
      const deadline = Date.now() + 5_000;
      while ((await stub.wrappedRuntimeStatus(runId)) !== "running") {
        if (Date.now() > deadline) {
          throw new Error("wrapped runtime did not start");
        }
        await runDurableObjectAlarm(stub);
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      await stub.completeWrapped(runId, value);
    },
    inspect: (runId) => stub.wrappedInspect(runId),
    result: (runId) => stub.wrappedResult(runId),
    abort: (runId, reason) => stub.wrappedAbort(runId, reason),
    pause: (runId) => stub.harnessPause(runId),
    resume: (runId) => stub.harnessResume(runId)
  };
}

runHarnessConformance("native", nativeHarness);
runHarnessConformance("wrapped", wrappedHarness);
