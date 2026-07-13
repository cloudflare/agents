import { describe, expect, it, vi } from "vitest";
import { createEventBus, type ObservabilityEvent } from "../../kernel/events.js";
import { createOverflowGuard, defaultContextOverflowClassifier } from "./overflow.js";

describe("defaultContextOverflowClassifier", () => {
  const phrases = [
    "Prompt is too long for this model.",
    "Error: context_length_exceeded",
    "You have exceeded the maximum context length of 128000 tokens.",
    "Input is too long: 500000 tokens",
    "Request contains too many tokens for the selected model.",
    "This request exceeds the model's context window.",
  ];

  it.each(phrases)("classifies %s as context_overflow (case-insensitive)", (message) => {
    expect(defaultContextOverflowClassifier(new Error(message))).toBe("context_overflow");
    expect(defaultContextOverflowClassifier(new Error(message.toUpperCase()))).toBe("context_overflow");
  });

  it("returns unknown for an unrelated error message", () => {
    expect(defaultContextOverflowClassifier(new Error("network timeout"))).toBe("unknown");
  });

  it("walks the .cause chain to find a matching phrase", () => {
    const root = new Error("network timeout");
    const middle = new Error("request failed", { cause: root });
    const top = new Error("upstream error", { cause: middle });
    root.message; // keep root referenced
    const withPhraseInCause = new Error("wrapper", {
      cause: new Error("upstream said: prompt is too long"),
    });
    expect(defaultContextOverflowClassifier(top)).toBe("unknown");
    expect(defaultContextOverflowClassifier(withPhraseInCause)).toBe("context_overflow");
  });

  it("handles non-Error values without throwing", () => {
    expect(defaultContextOverflowClassifier(undefined)).toBe("unknown");
    expect(defaultContextOverflowClassifier(null)).toBe("unknown");
    expect(defaultContextOverflowClassifier(42)).toBe("unknown");
    expect(defaultContextOverflowClassifier({ some: "object" })).toBe("unknown");
    expect(defaultContextOverflowClassifier("maximum context length exceeded")).toBe("context_overflow");
    expect(defaultContextOverflowClassifier("just a plain string")).toBe("unknown");
  });
});

function busHarness(): { bus: ReturnType<typeof createEventBus>; events: ObservabilityEvent[] } {
  const events: ObservabilityEvent[] = [];
  const bus = createEventBus({ agent: "test", name: "agent-1" }, () => 0);
  bus.subscribe("*", (e) => events.push(e));
  return { bus, events };
}

describe("createOverflowGuard", () => {
  describe("reactive", () => {
    it("compacts and returns retry when the classifier says overflow and history shortened", async () => {
      const { bus, events } = busHarness();
      const compact = vi.fn(async () => ({ shortened: true }));
      const guard = createOverflowGuard({ config: { reactive: true }, compact, bus });

      const result = await guard.handleTurnError(new Error("prompt is too long"), "req-1");
      expect(result).toBe("retry");
      expect(compact).toHaveBeenCalledTimes(1);
      const evt = events.find((e) => e.type === "chat:context:compacted");
      expect(evt).toBeDefined();
      expect(evt!.payload).toMatchObject({ reason: "reactive", shortened: true, requestId: "req-1", attempt: 1 });
    });

    it("returns terminal when compaction does not shorten history", async () => {
      const { bus } = busHarness();
      const compact = vi.fn(async () => ({ shortened: false }));
      const guard = createOverflowGuard({ config: { reactive: true }, compact, bus });

      const result = await guard.handleTurnError(new Error("context_length_exceeded"), "req-1");
      expect(result).toBe("terminal");
    });

    it("bounds retries by maxRetries per requestId", async () => {
      const { bus } = busHarness();
      const compact = vi.fn(async () => ({ shortened: true }));
      const guard = createOverflowGuard({ config: { reactive: true, maxRetries: 2 }, compact, bus });

      expect(await guard.handleTurnError(new Error("too many tokens"), "req-1")).toBe("retry");
      expect(await guard.handleTurnError(new Error("too many tokens"), "req-1")).toBe("retry");
      expect(await guard.handleTurnError(new Error("too many tokens"), "req-1")).toBe("terminal");
      expect(compact).toHaveBeenCalledTimes(2); // third call doesn't compact again
    });

    it("tracks retry budgets independently per requestId", async () => {
      const { bus } = busHarness();
      const compact = vi.fn(async () => ({ shortened: true }));
      const guard = createOverflowGuard({ config: { reactive: true, maxRetries: 1 }, compact, bus });

      expect(await guard.handleTurnError(new Error("too many tokens"), "req-1")).toBe("retry");
      expect(await guard.handleTurnError(new Error("too many tokens"), "req-2")).toBe("retry");
    });

    it("returns unhandled for non-overflow errors", async () => {
      const { bus } = busHarness();
      const compact = vi.fn(async () => ({ shortened: true }));
      const guard = createOverflowGuard({ config: { reactive: true }, compact, bus });

      const result = await guard.handleTurnError(new Error("network timeout"), "req-1");
      expect(result).toBe("unhandled");
      expect(compact).not.toHaveBeenCalled();
    });

    it("returns unhandled when reactive is not enabled", async () => {
      const { bus } = busHarness();
      const compact = vi.fn(async () => ({ shortened: true }));
      const guard = createOverflowGuard({ compact, bus });

      const result = await guard.handleTurnError(new Error("prompt is too long"), "req-1");
      expect(result).toBe("unhandled");
      expect(compact).not.toHaveBeenCalled();
    });

    it("uses a custom classify function when provided", async () => {
      const { bus } = busHarness();
      const compact = vi.fn(async () => ({ shortened: true }));
      const classify = vi.fn(() => "context_overflow" as const);
      const guard = createOverflowGuard({ config: { reactive: true }, classify, compact, bus });

      const result = await guard.handleTurnError(new Error("anything at all"), "req-1");
      expect(result).toBe("retry");
      expect(classify).toHaveBeenCalledWith(expect.any(Error));
    });
  });

  describe("proactive", () => {
    it("compacts mid-turn once usage crosses the 90% threshold", async () => {
      const { bus, events } = busHarness();
      const compact = vi.fn(async () => ({ shortened: true }));
      const guard = createOverflowGuard({
        config: { proactive: { maxInputTokens: 1000 } },
        compact,
        bus,
      });

      const ran = await guard.maybeCompactBeforeStep({ inputTokens: 900 }, "req-1");
      expect(ran).toBe(true);
      expect(compact).toHaveBeenCalledTimes(1);
      const evt = events.find((e) => e.type === "chat:context:compacted");
      expect(evt!.payload).toMatchObject({ reason: "proactive", requestId: "req-1", attempt: 1 });
    });

    it("does not compact below the threshold", async () => {
      const { bus } = busHarness();
      const compact = vi.fn(async () => ({ shortened: true }));
      const guard = createOverflowGuard({
        config: { proactive: { maxInputTokens: 1000 } },
        compact,
        bus,
      });

      const ran = await guard.maybeCompactBeforeStep({ inputTokens: 899 }, "req-1");
      expect(ran).toBe(false);
      expect(compact).not.toHaveBeenCalled();
    });

    it("bounds compactions per turn by maxCompactions", async () => {
      const { bus } = busHarness();
      const compact = vi.fn(async () => ({ shortened: true }));
      const guard = createOverflowGuard({
        config: { proactive: { maxInputTokens: 1000, maxCompactions: 2 } },
        compact,
        bus,
      });

      expect(await guard.maybeCompactBeforeStep({ inputTokens: 950 }, "req-1")).toBe(true);
      expect(await guard.maybeCompactBeforeStep({ inputTokens: 950 }, "req-1")).toBe(true);
      expect(await guard.maybeCompactBeforeStep({ inputTokens: 950 }, "req-1")).toBe(false);
      expect(compact).toHaveBeenCalledTimes(2);
    });

    it("resets the compaction budget per requestId", async () => {
      const { bus } = busHarness();
      const compact = vi.fn(async () => ({ shortened: true }));
      const guard = createOverflowGuard({
        config: { proactive: { maxInputTokens: 1000, maxCompactions: 1 } },
        compact,
        bus,
      });

      expect(await guard.maybeCompactBeforeStep({ inputTokens: 950 }, "req-1")).toBe(true);
      expect(await guard.maybeCompactBeforeStep({ inputTokens: 950 }, "req-2")).toBe(true);
    });

    it("no-ops when usage info is missing", async () => {
      const { bus } = busHarness();
      const compact = vi.fn(async () => ({ shortened: true }));
      const guard = createOverflowGuard({
        config: { proactive: { maxInputTokens: 1000 } },
        compact,
        bus,
      });

      expect(await guard.maybeCompactBeforeStep(undefined, "req-1")).toBe(false);
      expect(await guard.maybeCompactBeforeStep({}, "req-1")).toBe(false);
      expect(compact).not.toHaveBeenCalled();
    });

    it("no-ops when proactive is not configured", async () => {
      const { bus } = busHarness();
      const compact = vi.fn(async () => ({ shortened: true }));
      const guard = createOverflowGuard({ compact, bus });

      expect(await guard.maybeCompactBeforeStep({ inputTokens: 999999 }, "req-1")).toBe(false);
      expect(compact).not.toHaveBeenCalled();
    });
  });
});
