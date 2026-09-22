import { describe, expect, it } from "vitest";
import {
  createHarnessEffectRuntime,
  type HarnessRuntime,
  type HarnessRuntimeInspection
} from "../../harness";
import type { MachineJson } from "../../state-machine";

type Input = { prompt: string };
type Result = { text: string };

class FakeRuntime implements HarnessRuntime<Input, Result> {
  readonly starts: string[] = [];
  readonly executions = new Map<string, HarnessRuntimeInspection<Result>>();

  async start(input: Input, invocation: { executionId: string }) {
    this.starts.push(invocation.executionId);
    this.executions.set(invocation.executionId, {
      status: "running",
      progress: input.prompt
    });
  }

  async inspect(executionId: string) {
    return this.executions.get(executionId) ?? { status: "not-found" as const };
  }
}

const invocation = {
  effectId: "effect-1",
  idempotencyKey: "run:effect-1",
  signal: new AbortController().signal
};

describe("createHarnessEffectRuntime", () => {
  it("starts once and returns a durable pending execution ID", async () => {
    const runtime = new FakeRuntime();
    const effect = createHarnessEffectRuntime(runtime);

    await expect(
      effect.execute({ prompt: "hello" } satisfies MachineJson, invocation)
    ).resolves.toMatchObject({
      status: "running",
      externalId: "effect-1"
    });
    expect(runtime.starts).toEqual(["effect-1"]);
  });

  it("reconciles terminal output without starting again", async () => {
    const runtime = new FakeRuntime();
    runtime.executions.set("external-1", {
      status: "completed",
      result: { text: "done" }
    });
    const effect = createHarnessEffectRuntime(runtime);

    await expect(
      effect.reconcile?.("external-1", {
        ...invocation,
        externalId: "external-1"
      })
    ).resolves.toEqual({
      status: "completed",
      output: { text: "done" }
    });
    expect(runtime.starts).toEqual([]);
  });
});
