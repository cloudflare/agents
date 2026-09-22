import { env } from "cloudflare:workers";
import { runDurableObjectAlarm } from "cloudflare:test";
import {
  runHarnessConformance,
  type ConformanceHarness,
  type ConformanceSnapshot
} from "./conformance";

type ContractStub = DurableObjectStub & {
  submit(
    input: string,
    options?: { runId?: string; idempotencyKey?: string }
  ): Promise<{ runId: string; accepted: boolean }>;
  inspect(runId: string): Promise<ConformanceSnapshot | null>;
  abort(runId: string, reason?: string): Promise<boolean>;
  pause(runId: string): Promise<boolean>;
  resume(runId: string): Promise<boolean>;
  result(runId: string): Promise<string | null>;
};

type StateMachineAdapterStub = ContractStub & {
  send(
    runId: string,
    key: string,
    value: string,
    eventId: string
  ): Promise<unknown>;
};

type NativeHarnessStub = ContractStub & {
  answerPermission(
    gateId: string,
    approved: boolean,
    eventId: string
  ): Promise<unknown>;
};

type WrappedHarnessStub = ContractStub & {
  completeExecution(runId: string, result: string): Promise<void>;
  runtimeStatus(runId: string): Promise<string | null>;
};

function stateMachineHarness(): ConformanceHarness {
  const stub = env.StateMachineAdapterHarnessObject.getByName(
    crypto.randomUUID()
  ) as unknown as StateMachineAdapterStub;
  return {
    stub,
    submit: (key, options) => stub.submit(key, options),
    settle: async (runId, key, value) => {
      await stub.send(runId, key, value, `event_${crypto.randomUUID()}`);
      return value;
    },
    inspect: (runId) => stub.inspect(runId),
    result: (runId) => stub.result(runId),
    abort: (runId, reason) => stub.abort(runId, reason),
    pause: (runId) => stub.pause(runId),
    resume: (runId) => stub.resume(runId)
  };
}

function nativeHarness(): ConformanceHarness {
  const stub = env.NativeHarnessObject.getByName(
    crypto.randomUUID()
  ) as unknown as NativeHarnessStub;
  return {
    stub,
    submit: (key, options) => stub.submit(`exec:${key}`, options),
    settle: async (runId, key) => {
      const deadline = Date.now() + 5_000;
      let gate: { gateId: string } | undefined;
      while (!gate) {
        gate = (await stub.inspect(runId))?.gates?.[0];
        if (Date.now() > deadline) {
          throw new Error("native permission gate not found");
        }
        if (!gate) {
          await runDurableObjectAlarm(stub);
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
      }
      await stub.answerPermission(
        gate.gateId,
        true,
        `answer_${crypto.randomUUID()}`
      );
      return `effect:tool:exec:${key}`;
    },
    inspect: (runId) => stub.inspect(runId),
    result: (runId) => stub.result(runId),
    abort: (runId, reason) => stub.abort(runId, reason),
    pause: (runId) => stub.pause(runId),
    resume: (runId) => stub.resume(runId)
  };
}

function wrappedHarness(): ConformanceHarness {
  const stub = env.WrappedHarnessObject.getByName(
    crypto.randomUUID()
  ) as unknown as WrappedHarnessStub;
  return {
    stub,
    submit: (key, options) => stub.submit(key, options),
    settle: async (runId, _key, value) => {
      const deadline = Date.now() + 5_000;
      while ((await stub.runtimeStatus(runId)) !== "running") {
        if (Date.now() > deadline) {
          throw new Error("wrapped runtime did not start");
        }
        await runDurableObjectAlarm(stub);
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      await stub.completeExecution(runId, value);
      return value;
    },
    inspect: (runId) => stub.inspect(runId),
    result: (runId) => stub.result(runId),
    abort: (runId, reason) => stub.abort(runId, reason),
    pause: (runId) => stub.pause(runId),
    resume: (runId) => stub.resume(runId)
  };
}

runHarnessConformance("state-machine", stateMachineHarness);
runHarnessConformance("native", nativeHarness);
runHarnessConformance("wrapped", wrappedHarness);
