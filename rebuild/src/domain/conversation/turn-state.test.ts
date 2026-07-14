import { describe, expect, it } from "vitest";
import { createMemoryKeyValueStore } from "../../adapters/memory/store.js";
import { assistantMessage, type ChatMessage, type MessagePart, type ToolPart } from "../messages/model.js";
import type { Session } from "../session/session.js";
import { createConversationTurnState } from "./turn-state.js";

/** Minimal in-memory Session stand-in: only appendMessage/getHistory are exercised here. */
function fakeSession(initial: ChatMessage[] = []): Session {
  const messages = [...initial];
  return {
    async appendMessage(m: ChatMessage): Promise<void> {
      messages.push(m);
    },
    async getHistory(): Promise<ChatMessage[]> {
      return [...messages];
    },
  } as unknown as Session;
}

function setup() {
  const store = createMemoryKeyValueStore();
  const turnState = createConversationTurnState({ store });
  return { store, turnState };
}

describe("createConversationTurnState", () => {
  describe("partial bookkeeping", () => {
    it("recordPartial/partialFor round-trips per requestId", () => {
      const { turnState } = setup();
      const msg = assistantMessage([{ type: "text", text: "hi" }], "m1");
      turnState.recordPartial("req_1", msg);
      expect(turnState.partialFor("req_1")).toEqual(msg);
      expect(turnState.partialFor("req_2")).toBeUndefined();
    });

    it("clearPartial removes the stored partial", () => {
      const { turnState } = setup();
      turnState.recordPartial("req_1", assistantMessage([], "m1"));
      turnState.clearPartial("req_1");
      expect(turnState.partialFor("req_1")).toBeUndefined();
    });

    it("scopes partials under the given store's own prefix (no cross-instance leakage)", () => {
      const store = createMemoryKeyValueStore();
      const a = createConversationTurnState({ store });
      a.recordPartial("req_1", assistantMessage([], "m1"));
      expect([...store.list().keys()].every((k) => k.startsWith("partial:") || k === "lastRequestId")).toBe(true);
    });
  });

  describe("lastRequestId", () => {
    it("is undefined until set", () => {
      const { turnState } = setup();
      expect(turnState.lastRequestId()).toBeUndefined();
    });

    it("round-trips and can be cleared with undefined", () => {
      const { turnState } = setup();
      turnState.setLastRequestId("req_1");
      expect(turnState.lastRequestId()).toBe("req_1");
      turnState.setLastRequestId(undefined);
      expect(turnState.lastRequestId()).toBeUndefined();
    });
  });

  describe("channel bookkeeping", () => {
    it("stampChannel/channelFor round-trips per requestId", () => {
      const { turnState } = setup();
      turnState.stampChannel("req_1", "support");
      expect(turnState.channelFor("req_1")).toBe("support");
      expect(turnState.channelFor("req_2")).toBeUndefined();
    });
  });

  describe("commitInterruptedPartial", () => {
    it("is a no-op when there is no partial", async () => {
      const { turnState } = setup();
      const session = fakeSession();
      const result = await turnState.commitInterruptedPartial("req_1", session);
      expect(result).toBeUndefined();
      expect(await session.getHistory()).toHaveLength(0);
    });

    it("is a no-op when the partial has no parts", async () => {
      const { turnState } = setup();
      turnState.recordPartial("req_1", assistantMessage([], "m1"));
      const session = fakeSession();
      const result = await turnState.commitInterruptedPartial("req_1", session);
      expect(result).toBeUndefined();
    });

    it("repairs and appends the partial to the session, then clears it", async () => {
      const { turnState } = setup();
      const partial: ChatMessage = {
        id: "m1",
        role: "assistant",
        parts: [
          { type: "text", text: "partial answer" },
          { type: "tool-search", toolCallId: "call_1", state: "input-available", input: { q: "x" } } as ToolPart,
        ],
      };
      turnState.recordPartial("req_1", partial);
      const session = fakeSession();

      const result = await turnState.commitInterruptedPartial("req_1", session);

      expect(result).toBeDefined();
      const toolPart = result!.parts.find((p) => p.type === "tool-search") as ToolPart;
      expect(toolPart.state).toBe("output-error"); // default repair for an unsettled tool part
      const history = await session.getHistory();
      expect(history).toHaveLength(1);
      expect(history[0]!.id).toBe("m1");
      expect(turnState.partialFor("req_1")).toBeUndefined();
    });

    it("uses a custom repairPart when provided", async () => {
      const { turnState } = setup();
      const partial: ChatMessage = {
        id: "m1",
        role: "assistant",
        parts: [{ type: "tool-search", toolCallId: "call_1", state: "input-available", input: {} } as ToolPart],
      };
      turnState.recordPartial("req_1", partial);
      const session = fakeSession();

      const repairPart = (part: ToolPart): MessagePart => ({ ...part, state: "output-available", output: "custom" });
      const result = await turnState.commitInterruptedPartial("req_1", session, repairPart);

      const toolPart = result!.parts.find((p) => p.type === "tool-search") as ToolPart;
      expect(toolPart).toMatchObject({ state: "output-available", output: "custom" });
    });

    it("is a no-op when the partial's id already exists in session history (already committed)", async () => {
      const { turnState } = setup();
      const existing = assistantMessage([{ type: "text", text: "already there" }], "m1");
      const session = fakeSession([existing]);
      turnState.recordPartial("req_1", assistantMessage([{ type: "text", text: "partial" }], "m1"));

      const result = await turnState.commitInterruptedPartial("req_1", session);

      expect(result).toBeUndefined();
      expect(await session.getHistory()).toHaveLength(1);
    });
  });
});
