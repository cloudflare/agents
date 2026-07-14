import { describe, expect, it, vi } from "vitest";
import { assistantMessage, type ChatMessage, type ToolPart } from "../messages/model.js";
import type { Session } from "../session/session.js";
import type { ActionService, ParkedResolution } from "../actions/actions.js";
import type { AssembledTools } from "../tools/registry.js";
import type { ConversationEvent } from "../events/log.js";
import { createPendingInteractions } from "./continuation.js";

/** Minimal in-memory Session covering only what continuation.ts touches. */
function fakeSession(initial: ChatMessage[] = []) {
  const messages = [...initial];
  const session: Partial<Session> = {
    async appendMessage(m: ChatMessage) {
      messages.push(m);
    },
    async updateMessage(m: ChatMessage) {
      const idx = messages.findIndex((x) => x.id === m.id);
      if (idx === -1) throw new Error("not found");
      messages[idx] = m;
    },
    async getLatestLeaf() {
      return messages[messages.length - 1];
    },
    async getHistory() {
      return [...messages];
    },
  };
  return session as Session;
}

function fakeActions(overrides?: Partial<ActionService>): ActionService {
  return {
    compile: vi.fn(),
    authorizeTurnOnce: vi.fn(async () => {}),
    park: vi.fn(() => "exec_1"),
    pendingApprovals: vi.fn(() => []),
    approveExecution: vi.fn(async () => undefined),
    rejectExecution: vi.fn(async () => {}),
    attachments: vi.fn(() => []),
    clearTurn: vi.fn(),
    maybeParkSuspension: vi.fn(() => ({ parked: false })),
    ...overrides,
  } as unknown as ActionService;
}

function fakeTools(execute: AssembledTools["execute"]): AssembledTools {
  return {
    tools: {},
    descriptors: () => [],
    execute,
    isClientTool: () => false,
    needsApproval: async () => false,
    capabilityBlock: () => "",
  };
}

function harness(opts?: {
  session?: Session;
  actions?: ActionService;
  tools?: AssembledTools;
  debounceMs?: number;
  requestId?: string;
}) {
  const published: ConversationEvent[] = [];
  const continuations: number[] = [];
  const session = opts?.session ?? fakeSession();
  const actions = opts?.actions ?? fakeActions();
  const tools = opts?.tools ?? fakeTools(async () => ({ output: "ok", isError: false }));

  const pending = createPendingInteractions({
    session: async () => session,
    actions,
    tools: async () => tools,
    requestId: () => opts?.requestId ?? "req_1",
    publish: (e) => published.push(e),
    requestContinuation: () => continuations.push(1),
    ...(opts?.debounceMs !== undefined ? { debounceMs: opts.debounceMs } : {}),
  });

  return { pending, published, continuations, session, actions, tools };
}

function toolMessage(parts: ToolPart[]): ChatMessage {
  return { id: "m1", role: "assistant", parts };
}

describe("createPendingInteractions", () => {
  describe("applyToolResult", () => {
    it("writes output into the matching input-available tool part and publishes message:updated", async () => {
      const msg = toolMessage([{ type: "tool-search", toolCallId: "call_1", state: "input-available", input: {} }]);
      const { pending, published, session } = harness({ session: fakeSession([msg]), debounceMs: 0 });

      await pending.applyToolResult({ toolCallId: "call_1", output: 42 });

      const updated = await session.getLatestLeaf();
      const part = updated!.parts.find((p) => p.type === "tool-search") as ToolPart;
      expect(part).toMatchObject({ state: "output-available", output: 42 });
      expect(published).toHaveLength(1);
      expect(published[0]).toMatchObject({ type: "message:updated", requestId: "req_1" });
    });

    it("settles as output-error when isError is set", async () => {
      const msg = toolMessage([{ type: "tool-search", toolCallId: "call_1", state: "input-available", input: {} }]);
      const { pending, session } = harness({ session: fakeSession([msg]) });

      await pending.applyToolResult({ toolCallId: "call_1", output: "boom", isError: true });

      const updated = await session.getLatestLeaf();
      const part = updated!.parts.find((p) => p.type === "tool-search") as ToolPart;
      expect(part).toMatchObject({ state: "output-error", errorText: "boom" });
    });

    it("is a no-op when there is no assistant leaf message", async () => {
      const { pending, published } = harness({ session: fakeSession([]) });
      await pending.applyToolResult({ toolCallId: "call_1", output: 1 });
      expect(published).toHaveLength(0);
    });

    it("leaves an already-settled tool part untouched", async () => {
      const msg = toolMessage([{ type: "tool-search", toolCallId: "call_1", state: "output-available", output: 1 }]);
      const { pending, session } = harness({ session: fakeSession([msg]) });
      await pending.applyToolResult({ toolCallId: "call_1", output: 999 });
      const updated = await session.getLatestLeaf();
      expect((updated!.parts[0] as ToolPart).output).toBe(1);
    });

    it("debounces requestContinuation once every tool part settles", async () => {
      vi.useFakeTimers();
      try {
        const msg = toolMessage([{ type: "tool-search", toolCallId: "call_1", state: "input-available", input: {} }]);
        const { pending, continuations } = harness({ session: fakeSession([msg]), debounceMs: 100 });

        await pending.applyToolResult({ toolCallId: "call_1", output: 1 });
        expect(continuations).toHaveLength(0);
        await vi.advanceTimersByTimeAsync(100);
        expect(continuations).toHaveLength(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it("fires requestContinuation synchronously when debounceMs is 0", async () => {
      const msg = toolMessage([{ type: "tool-search", toolCallId: "call_1", state: "input-available", input: {} }]);
      const { pending, continuations } = harness({ session: fakeSession([msg]), debounceMs: 0 });
      await pending.applyToolResult({ toolCallId: "call_1", output: 1 });
      expect(continuations).toHaveLength(1);
    });

    it("does not continue while other tool parts on the message are still unsettled", async () => {
      const msg = toolMessage([
        { type: "tool-a", toolCallId: "call_1", state: "input-available", input: {} },
        { type: "tool-b", toolCallId: "call_2", state: "input-available", input: {} },
      ]);
      const { pending, continuations } = harness({ session: fakeSession([msg]), debounceMs: 0 });
      await pending.applyToolResult({ toolCallId: "call_1", output: 1 });
      expect(continuations).toHaveLength(0);
    });

    it("re-debouncing the same message cancels the earlier timer", async () => {
      vi.useFakeTimers();
      try {
        const msg = toolMessage([
          { type: "tool-a", toolCallId: "call_1", state: "input-available", input: {} },
          { type: "tool-b", toolCallId: "call_2", state: "input-available", input: {} },
        ]);
        const { pending, continuations } = harness({ session: fakeSession([msg]), debounceMs: 100 });
        await pending.applyToolResult({ toolCallId: "call_1", output: 1 });
        await vi.advanceTimersByTimeAsync(50);
        await pending.applyToolResult({ toolCallId: "call_2", output: 2 });
        await vi.advanceTimersByTimeAsync(50);
        expect(continuations).toHaveLength(0); // first timer cancelled; second not yet due
        await vi.advanceTimersByTimeAsync(50);
        expect(continuations).toHaveLength(1);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("resolveApproval — inline toolCallId path", () => {
    it("approved: executes via tools.execute and settles output-available", async () => {
      const msg = toolMessage([{ type: "tool-dangerous", toolCallId: "call_1", state: "approval-requested", input: { x: 1 } }]);
      const executeSpy = vi.fn(async () => ({ output: { result: 2 }, isError: false }));
      const { pending, session, published } = harness({
        session: fakeSession([msg]),
        tools: fakeTools(executeSpy),
        debounceMs: 0,
      });

      await pending.resolveApproval({ toolCallId: "call_1", approved: true });

      expect(executeSpy).toHaveBeenCalledWith("dangerous", { x: 1 }, expect.objectContaining({ toolCallId: "call_1", requestId: "req_1" }));
      const updated = await session.getLatestLeaf();
      expect(updated!.parts[0]).toMatchObject({ state: "output-available", output: { result: 2 } });
      expect(published).toHaveLength(1);
    });

    it("rejected: settles output-error with the rejection reason, without executing", async () => {
      const msg = toolMessage([{ type: "tool-dangerous", toolCallId: "call_1", state: "approval-requested", input: {} }]);
      const executeSpy = vi.fn(async () => ({ output: "should not run", isError: false }));
      const { pending, session } = harness({ session: fakeSession([msg]), tools: fakeTools(executeSpy) });

      await pending.resolveApproval({ toolCallId: "call_1", approved: false, reason: "no thanks" });

      expect(executeSpy).not.toHaveBeenCalled();
      const updated = await session.getLatestLeaf();
      expect(updated!.parts[0]).toMatchObject({ state: "output-error" });
      expect((updated!.parts[0] as ToolPart).errorText).toContain("no thanks");
    });

    it("is a no-op when the tool part is not in approval-requested state", async () => {
      const msg = toolMessage([{ type: "tool-dangerous", toolCallId: "call_1", state: "output-available", output: 1 }]);
      const { pending, published } = harness({ session: fakeSession([msg]) });
      await pending.resolveApproval({ toolCallId: "call_1", approved: true });
      expect(published).toHaveLength(0);
    });

    it("is a no-op with neither toolCallId nor executionId", async () => {
      const { pending, published } = harness();
      await pending.resolveApproval({ approved: true });
      expect(published).toHaveLength(0);
    });
  });

  describe("resolveApproval — executionId path (durable-pause)", () => {
    it("approved: delegates to actions.approveExecution", async () => {
      const actions = fakeActions();
      const { pending } = harness({ actions });
      await pending.resolveApproval({ executionId: "exec_1", approved: true });
      expect(actions.approveExecution).toHaveBeenCalledWith("exec_1");
    });

    it("rejected: delegates to actions.rejectExecution with the reason", async () => {
      const actions = fakeActions();
      const { pending } = harness({ actions });
      await pending.resolveApproval({ executionId: "exec_1", approved: false, reason: "nope" });
      expect(actions.rejectExecution).toHaveBeenCalledWith("exec_1", "nope");
    });
  });

  describe("onExecutionResolved", () => {
    it("writes the resolution's output into the matching tool part wherever it lives in history", async () => {
      const msg = toolMessage([{ type: "tool-deploy", toolCallId: "call_1", state: "approval-requested", input: {} }]);
      const { pending, session, published } = harness({ session: fakeSession([msg]), debounceMs: 0 });

      const resolution: ParkedResolution = { toolCallId: "call_1", requestId: "req_1", output: { deployed: true } };
      await pending.onExecutionResolved("exec_1", resolution);

      const history = await session.getHistory();
      const part = history[0]!.parts.find((p) => p.type === "tool-deploy") as ToolPart;
      expect(part).toMatchObject({ state: "output-available", output: { deployed: true } });
      expect(published).toHaveLength(1);
    });

    it("writes a rejection as output-error", async () => {
      const msg = toolMessage([{ type: "tool-deploy", toolCallId: "call_1", state: "approval-requested", input: {} }]);
      const { pending, session } = harness({ session: fakeSession([msg]) });

      const resolution: ParkedResolution = {
        toolCallId: "call_1",
        requestId: "req_1",
        rejection: { name: "ActionRejectedError", message: "denied" },
      };
      await pending.onExecutionResolved("exec_1", resolution);

      const history = await session.getHistory();
      const part = history[0]!.parts.find((p) => p.type === "tool-deploy") as ToolPart;
      expect(part).toMatchObject({ state: "output-error", errorText: "denied" });
    });

    it("is a no-op when no message in history carries the toolCallId", async () => {
      const { pending, published } = harness({ session: fakeSession([]) });
      await pending.onExecutionResolved("exec_1", { toolCallId: "call_x", requestId: "req_1", output: 1 });
      expect(published).toHaveLength(0);
    });
  });

  describe("maybeContinue", () => {
    it("no-ops for a message with no tool parts", () => {
      const { pending, continuations } = harness({ debounceMs: 0 });
      pending.maybeContinue(assistantMessage([{ type: "text", text: "hi" }], "m1"));
      expect(continuations).toHaveLength(0);
    });
  });

  describe("cancelPending", () => {
    it("clears in-flight debounce timers so they never fire", async () => {
      vi.useFakeTimers();
      try {
        const msg = toolMessage([{ type: "tool-search", toolCallId: "call_1", state: "input-available", input: {} }]);
        const { pending, continuations } = harness({ session: fakeSession([msg]), debounceMs: 100 });
        await pending.applyToolResult({ toolCallId: "call_1", output: 1 });
        pending.cancelPending();
        await vi.advanceTimersByTimeAsync(200);
        expect(continuations).toHaveLength(0);
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
