import { describe, expect, it } from "vitest";
import {
  burnCpu,
  crashPrompt,
  currentTime,
  fillMemory,
  generateBytes,
  longRunningPrompt,
  secondaryTask,
  sleep,
  testingPrompts
} from "../tools/testing";
import { createTestingTools } from "../tools/testing/ai";

const callOptions = { toolCallId: "call-1", messages: [], context: {} };

/** Abort on the next macrotask, after the callee has started its work. */
function abortSoon(reason: Error): AbortSignal {
  const controller = new AbortController();
  setTimeout(() => controller.abort(reason), 0);
  return controller.signal;
}

describe("sleep", () => {
  it("waits for the requested time and reports how long it took", async () => {
    const start = Date.now();

    const result = await sleep(0.05);

    expect(Date.now() - start).toBeGreaterThanOrEqual(50);
    expect(result.sleptMs).toBeGreaterThanOrEqual(50);
  });

  it("rejects with the abort reason when aborted mid-wait", async () => {
    const reason = new Error("turn cancelled");

    await expect(sleep(60, abortSoon(reason))).rejects.toBe(reason);
  });

  it("rejects immediately when the signal is already aborted", async () => {
    const reason = new Error("already gone");

    await expect(sleep(60, AbortSignal.abort(reason))).rejects.toBe(reason);
  });
});

describe("currentTime", () => {
  it("returns the same instant as ISO and epoch milliseconds", () => {
    const before = Date.now();

    const { iso, epochMs } = currentTime();

    expect(new Date(iso).getTime()).toBe(epochMs);
    expect(epochMs).toBeGreaterThanOrEqual(before);
  });
});

describe("fillMemory", () => {
  it("keeps allocating until aborted, then rejects with the reason", async () => {
    const reason = new Error("stop filling");

    await expect(fillMemory(abortSoon(reason))).rejects.toBe(reason);
  });
});

describe("generateBytes", () => {
  it("streams bytes without ending", async () => {
    const response = generateBytes();
    expect(response.headers.get("content-type")).toBe(
      "application/octet-stream"
    );
    const reader = response.body?.getReader();
    if (reader === undefined) throw new Error("expected a body");

    let bytes = 0;
    for (let i = 0; i < 4; i++) {
      const { done, value } = await reader.read();
      expect(done).toBe(false);
      bytes += value?.length ?? 0;
    }
    await reader.cancel();

    expect(bytes).toBe(4 * 64 * 1024);
  });
});

describe("burnCpu", () => {
  it("hashes a finite body to the end and reports its size", async () => {
    const body = new Uint8Array(100_000).fill(7);

    const first = await burnCpu(new Response(body));
    const second = await burnCpu(new Response(body));

    expect(first.bytes).toBe(100_000);
    expect(second).toEqual(first);
  });

  it("cancels an endless body when aborted, then rejects with the reason", async () => {
    const reason = new Error("stop burning");
    let cancelled: unknown;
    // Waits on a timer before each chunk, like a network read. Reading an
    // in-process stream never reaches a macrotask, so no abort could land.
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        await new Promise((resolve) => setTimeout(resolve, 0));
        controller.enqueue(new Uint8Array(1024));
      },
      cancel(why) {
        cancelled = why;
      }
    });

    await expect(burnCpu(new Response(body), abortSoon(reason))).rejects.toBe(
      reason
    );
    expect(cancelled).toBe(reason);
  });

  it("rejects before reading when the signal is already aborted", async () => {
    const reason = new Error("already gone");

    await expect(
      burnCpu(generateBytes(), AbortSignal.abort(reason))
    ).rejects.toBe(reason);
  });

  it("handles a response with no body", async () => {
    expect(await burnCpu(new Response(null))).toMatchObject({ bytes: 0 });
  });
});

describe("prompts", () => {
  it("loops sleep and current_time for 30 minutes, then runs the secondary task", () => {
    const prompt = testingPrompts.longRunning;

    expect(prompt).toBe(longRunningPrompt());
    expect(prompt).toContain("sleep with seconds set to 60");
    expect(prompt).toContain("less than 30 minutes");
    expect(prompt).toContain(secondaryTask.instruction);
  });

  it("uses the requested duration, interval, and follow-on task", () => {
    const prompt = longRunningPrompt({
      minutes: 5,
      sleepSeconds: 10,
      then: "say hello."
    });

    expect(prompt).toContain("sleep with seconds set to 10");
    expect(prompt).toContain("less than 5 minutes");
    expect(prompt).toContain("Then say hello.");
  });

  it("calls the crash tool once, between other tool calls", () => {
    expect(testingPrompts.oom).toBe(crashPrompt("oom"));
    expect(testingPrompts.burnCpu).toBe(crashPrompt("burn_cpu"));
    const prompt = crashPrompt("burn_cpu", { then: "say hello." });
    expect(prompt).toContain("1. Call current_time.");
    expect(prompt).toContain("Call burn_cpu exactly once");
    expect(prompt).toContain("Do not call burn_cpu again");
    expect(prompt).toContain("Then say hello.");
  });
});

describe("createTestingTools", () => {
  it("exposes the four tools under the names the prompts use", () => {
    expect(Object.keys(createTestingTools()).sort()).toEqual([
      "burn_cpu",
      "current_time",
      "oom",
      "sleep"
    ]);
  });

  it("sleeps and honors the call's abort signal", async () => {
    const { sleep: sleepTool } = createTestingTools();
    const reason = new Error("turn cancelled");

    expect(
      await sleepTool.execute?.({ seconds: 0.01 }, callOptions)
    ).toMatchObject({ sleptMs: expect.any(Number) });
    await expect(
      sleepTool.execute?.(
        { seconds: 60 },
        { ...callOptions, abortSignal: abortSoon(reason) }
      )
    ).rejects.toBe(reason);
  });

  it("reads burn_cpu's bytes from the configured source", async () => {
    const { burn_cpu } = createTestingTools({
      bytes: async () => new Response(new Uint8Array(1234))
    });

    expect(await burn_cpu.execute?.({}, callOptions)).toMatchObject({
      bytes: 1234
    });
  });

  it("stops oom when the call is aborted", async () => {
    const { oom } = createTestingTools();
    const reason = new Error("turn cancelled");

    await expect(
      oom.execute?.({}, { ...callOptions, abortSignal: abortSoon(reason) })
    ).rejects.toBe(reason);
  });
});
