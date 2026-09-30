import { describe, expect, it } from "vitest";
import {
  createTestingTools,
  longRunningPrompt,
  testingPrompts
} from "../tools/testing";

const callOptions = { toolCallId: "call-1", messages: [], context: {} };

describe("createTestingTools", () => {
  it("exposes the four testing tools", () => {
    expect(Object.keys(createTestingTools()).sort()).toEqual([
      "burn_cpu",
      "get_current_time",
      "oom",
      "sleep"
    ]);
  });

  describe("sleep", () => {
    it("waits for the requested time and reports how long it took", async () => {
      const { sleep } = createTestingTools();
      const start = Date.now();

      const result = await sleep.execute?.({ seconds: 0.05 }, callOptions);

      expect(Date.now() - start).toBeGreaterThanOrEqual(50);
      expect(result).toEqual({ sleptMs: expect.any(Number) });
    });

    it("rejects with the abort reason when the call is aborted", async () => {
      const { sleep } = createTestingTools();
      const controller = new AbortController();
      const reason = new Error("turn cancelled");

      const result = sleep.execute?.(
        { seconds: 60 },
        { ...callOptions, abortSignal: controller.signal }
      );
      controller.abort(reason);

      await expect(result).rejects.toBe(reason);
    });

    it("rejects immediately when the signal is already aborted", async () => {
      const { sleep } = createTestingTools();
      const reason = new Error("already gone");

      const result = sleep.execute?.(
        { seconds: 60 },
        { ...callOptions, abortSignal: AbortSignal.abort(reason) }
      );

      await expect(result).rejects.toBe(reason);
    });
  });

  describe("get_current_time", () => {
    it("returns the same instant as ISO and epoch milliseconds", async () => {
      const { get_current_time } = createTestingTools();
      const before = Date.now();

      const result = await get_current_time.execute?.({}, callOptions);

      if (result === undefined || !("iso" in result)) {
        throw new Error("expected a time result");
      }
      expect(new Date(result.iso).getTime()).toBe(result.epochMs);
      expect(result.epochMs).toBeGreaterThanOrEqual(before);
    });
  });

  describe("oom", () => {
    it("stops at the configured cap where no memory limit is enforced", async () => {
      const { oom } = createTestingTools({ oomLimitMiB: 4 });

      const result = await oom.execute?.({}, callOptions);

      expect(result).toEqual({ allocatedMiB: 4 });
    });
  });

  describe("burn_cpu", () => {
    it("spins inside the call without yielding to the event loop", () => {
      const { burn_cpu } = createTestingTools({ burnCpuMs: 50 });
      const start = Date.now();

      // Not awaited. If execute yielded, it would hand back a pending promise
      // almost immediately instead of returning after the burn.
      const result = burn_cpu.execute?.({}, callOptions);

      expect(Date.now() - start).toBeGreaterThanOrEqual(50);
      expect(result).toEqual({
        burnedMs: expect.any(Number),
        iterations: expect.any(Number)
      });
    });
  });
});

describe("testing prompts", () => {
  it("asks for a 30-minute loop of 60-second sleeps by default", () => {
    expect(testingPrompts.longRunning).toBe(longRunningPrompt());
    expect(testingPrompts.longRunning).toContain("seconds set to 60");
    expect(testingPrompts.longRunning).toContain("less than 30 minutes");
  });

  it("uses the requested duration and interval", () => {
    const prompt = longRunningPrompt({ minutes: 5, sleepSeconds: 10 });

    expect(prompt).toContain("seconds set to 10");
    expect(prompt).toContain("less than 5 minutes");
  });

  it("names the destructive tools", () => {
    expect(testingPrompts.oom).toContain("oom");
    expect(testingPrompts.burnCpu).toContain("burn_cpu");
  });
});
