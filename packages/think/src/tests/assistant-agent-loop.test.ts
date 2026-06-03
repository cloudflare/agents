import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { getAgentByName } from "agents";
import type { UIMessage } from "ai";
import { defaultContextOverflowClassifier } from "../think";

const MSG_CHAT_REQUEST = "cf_agent_use_chat_request";
const MSG_CHAT_RESPONSE = "cf_agent_use_chat_response";

function kebab(className: string): string {
  return className
    .replace(/([a-z])([A-Z])/g, "$1-$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1-$2")
    .toLowerCase();
}

async function connectWS(agentClass: string, room: string) {
  const slug = kebab(agentClass);
  const res = await exports.default.fetch(
    `http://example.com/agents/${slug}/${room}`,
    { headers: { Upgrade: "websocket" } }
  );
  expect(res.status).toBe(101);
  const ws = res.webSocket as WebSocket;
  expect(ws).toBeDefined();
  ws.accept();
  return { ws };
}

function collectMessages(
  ws: WebSocket,
  count: number,
  timeout = 5000
): Promise<Array<Record<string, unknown>>> {
  return new Promise((resolve) => {
    const messages: Array<Record<string, unknown>> = [];
    const timer = setTimeout(() => resolve(messages), timeout);
    const handler = (e: MessageEvent) => {
      try {
        messages.push(JSON.parse(e.data as string) as Record<string, unknown>);
        if (messages.length >= count) {
          clearTimeout(timer);
          ws.removeEventListener("message", handler);
          resolve(messages);
        }
      } catch {
        // ignore
      }
    };
    ws.addEventListener("message", handler);
  });
}

function waitForDone(
  ws: WebSocket,
  timeout = 10000
): Promise<Array<Record<string, unknown>>> {
  return new Promise((resolve, reject) => {
    const messages: Array<Record<string, unknown>> = [];
    const timer = setTimeout(
      () => reject(new Error("Timeout waiting for done")),
      timeout
    );
    const handler = (e: MessageEvent) => {
      try {
        const msg = JSON.parse(e.data as string) as Record<string, unknown>;
        messages.push(msg);
        if (msg.type === MSG_CHAT_RESPONSE && msg.done === true) {
          clearTimeout(timer);
          ws.removeEventListener("message", handler);
          resolve(messages);
        }
      } catch {
        // ignore
      }
    };
    ws.addEventListener("message", handler);
  });
}

function closeWS(ws: WebSocket): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, 200);
    ws.addEventListener(
      "close",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true }
    );
    ws.close();
  });
}

function sendChatRequest(ws: WebSocket, text: string, requestId?: string) {
  const id = requestId ?? crypto.randomUUID();
  const userMessage: UIMessage = {
    id: crypto.randomUUID(),
    role: "user",
    parts: [{ type: "text", text }]
  };
  ws.send(
    JSON.stringify({
      type: MSG_CHAT_REQUEST,
      id,
      init: {
        method: "POST",
        body: JSON.stringify({ messages: [userMessage] })
      }
    })
  );
  return { id, userMessage };
}

// ── Tests ─────────────────────────────────────────────────────────

describe("Think — agentic loop", () => {
  describe("getModel() error", () => {
    it("returns an error when getModel is not overridden", async () => {
      const room = crypto.randomUUID();
      const { ws } = await connectWS("BareAssistantAgent", room);

      // Skip initial messages
      await collectMessages(ws, 3);

      const done = waitForDone(ws);
      sendChatRequest(ws, "hello");
      const messages = await done;

      const errorMsg = messages.find(
        (m) =>
          m.type === MSG_CHAT_RESPONSE && m.done === true && m.error === true
      );
      expect(errorMsg).toBeDefined();
      expect(errorMsg!.body).toContain("getModel");

      await closeWS(ws);
    });
  });

  describe("default loop — text only", () => {
    it("streams a response using the mock model", async () => {
      const room = crypto.randomUUID();
      const { ws } = await connectWS("LoopTestAgent", room);

      // Skip initial messages
      await collectMessages(ws, 3);

      const done = waitForDone(ws);
      sendChatRequest(ws, "Say hi");
      const messages = await done;

      const responseChunks = messages.filter(
        (m) => m.type === MSG_CHAT_RESPONSE && m.done === false
      );
      expect(responseChunks.length).toBeGreaterThan(0);

      const bodies = responseChunks
        .map((m) => m.body as string)
        .filter(Boolean);
      const hasText = bodies.some((b) => {
        try {
          const parsed = JSON.parse(b) as Record<string, unknown>;
          return parsed.type === "text-delta" || parsed.type === "text-start";
        } catch {
          return false;
        }
      });
      expect(hasText).toBe(true);

      await closeWS(ws);
    });

    it("persists assistant message after streaming", async () => {
      const room = crypto.randomUUID();
      const { ws } = await connectWS("LoopTestAgent", room);
      const agent = await getAgentByName(env.LoopTestAgent, room);

      // Skip initial messages
      await collectMessages(ws, 3);

      const done = waitForDone(ws);
      sendChatRequest(ws, "Hello");
      await done;

      // Wait for the messages broadcast after persistence
      await collectMessages(ws, 1, 3000);

      const msgs = (await (
        agent as unknown as { getMessages(): Promise<UIMessage[]> }
      ).getMessages()) as UIMessage[];
      expect(msgs.length).toBeGreaterThanOrEqual(2);

      const assistantMsg = msgs.find((m) => m.role === "assistant");
      expect(assistantMsg).toBeDefined();

      await closeWS(ws);
    });
  });

  describe("default loop — with tools", () => {
    it("executes a tool and returns text after", async () => {
      const room = crypto.randomUUID();
      const { ws } = await connectWS("LoopToolTestAgent", room);

      // Skip initial messages
      await collectMessages(ws, 3);

      const done = waitForDone(ws, 15000);
      sendChatRequest(ws, "Use the echo tool");
      const messages = await done;

      const responseChunks = messages.filter(
        (m) => m.type === MSG_CHAT_RESPONSE && m.done === false
      );
      expect(responseChunks.length).toBeGreaterThan(0);

      await closeWS(ws);
    });

    it("custom maxSteps property is respected", async () => {
      const room = crypto.randomUUID();
      const { ws } = await connectWS("LoopToolTestAgent", room);

      // Skip initial messages
      await collectMessages(ws, 3);

      const done = waitForDone(ws, 15000);
      sendChatRequest(ws, "test step limit");
      const messages = await done;

      const doneMsg = messages.find(
        (m) => m.type === MSG_CHAT_RESPONSE && m.done === true
      );
      expect(doneMsg).toBeDefined();

      await closeWS(ws);
    });
  });

  describe("mid-turn context-overflow recovery (opt-in)", () => {
    type OverflowResult = {
      done: boolean;
      error?: string;
      compactionCount: number;
      modelCalls: number;
      compactionEvents: number;
      errorClassification?: string;
    };

    type OverflowAgent = {
      testChat(
        message: string,
        enabled: boolean,
        opts?: { noOpCompaction?: boolean; alwaysOverflow?: boolean }
      ): Promise<OverflowResult>;
      testProactive(message: string): Promise<OverflowResult>;
      testProgrammatic(message: string): Promise<OverflowResult>;
      enableOverflowRecoveryForWsTest(): Promise<void>;
      getOverflowStats(): Promise<{
        compactionCount: number;
        modelCalls: number;
        compactionEvents: number;
      }>;
    };

    it("compacts and retries when enabled, recovering the turn", async () => {
      const room = crypto.randomUUID();
      const agent = (await getAgentByName(
        env.OverflowRecoveryTestAgent,
        room
      )) as unknown as OverflowAgent;

      const result = await agent.testChat("trigger overflow", true);

      // The turn recovers: no terminal error, compaction fired once, and the
      // model was called twice (overflow attempt + recompacted retry).
      expect(result.error).toBeUndefined();
      expect(result.done).toBe(true);
      expect(result.compactionCount).toBe(1);
      expect(result.modelCalls).toBe(2);
      // Exactly one observability event per compaction (no double-emit).
      expect(result.compactionEvents).toBe(1);
    });

    it("stays terminal when disabled (no compaction, surfaces the error)", async () => {
      const room = crypto.randomUUID();
      const agent = (await getAgentByName(
        env.OverflowRecoveryTestAgent,
        room
      )) as unknown as OverflowAgent;

      const result = await agent.testChat("trigger overflow", false);

      // Opt-in off: the overflow error is delivered terminally, no compaction,
      // and the model is called exactly once (no retry).
      expect(result.error).toBeDefined();
      expect(result.error).toContain("prompt is too long");
      expect(result.compactionCount).toBe(0);
      expect(result.modelCalls).toBe(1);
      expect(result.compactionEvents).toBe(0);
    });

    it("falls through to a terminal error (via onChatError) when compaction can't shorten", async () => {
      const room = crypto.randomUUID();
      const agent = (await getAgentByName(
        env.OverflowRecoveryTestAgent,
        room
      )) as unknown as OverflowAgent;

      const result = await agent.testChat("trigger overflow", true, {
        noOpCompaction: true
      });

      // Recovery is enabled but compaction is a no-op: the turn must not loop
      // or end silently — it surfaces the overflow terminally, routed through
      // onChatError with the context_overflow classification.
      expect(result.error).toBeDefined();
      expect(result.error).toContain("prompt is too long");
      expect(result.errorClassification).toBe("context_overflow");
      // One compaction attempt was made (and reported once), but it didn't
      // shorten, so no retry: the model was called exactly once.
      expect(result.modelCalls).toBe(1);
      expect(result.compactionEvents).toBe(1);
    });

    it("stops after contextOverflow.maxRetries when the overflow persists (no infinite loop)", async () => {
      const room = crypto.randomUUID();
      const agent = (await getAgentByName(
        env.OverflowRecoveryTestAgent,
        room
      )) as unknown as OverflowAgent;

      // Compaction shortens, but the model keeps overflowing on every call.
      const result = await agent.testChat("trigger overflow", true, {
        alwaysOverflow: true
      });

      // attempt 0 overflows → compact (shortens) → retry; attempt 1 overflows
      // again but the budget (default 1) is spent, so it terminalizes. Bounded:
      // exactly 2 model calls and 1 compaction, then a terminal error.
      expect(result.error).toBeDefined();
      expect(result.error).toContain("prompt is too long");
      expect(result.errorClassification).toBe("context_overflow");
      expect(result.modelCalls).toBe(2);
      expect(result.compactionCount).toBe(1);
      expect(result.compactionEvents).toBe(1);
    });

    it("recovers a context overflow on the programmatic (saveMessages) path", async () => {
      const room = crypto.randomUUID();
      const agent = (await getAgentByName(
        env.OverflowRecoveryTestAgent,
        room
      )) as unknown as OverflowAgent;

      const result = await agent.testProgrammatic("trigger overflow");

      expect(result.error).toBeUndefined();
      expect(result.done).toBe(true);
      expect(result.compactionCount).toBe(1);
      expect(result.modelCalls).toBe(2);
      expect(result.compactionEvents).toBe(1);
    });

    it("recovers a context overflow on the WebSocket turn path", async () => {
      const room = crypto.randomUUID();
      const { ws } = await connectWS("OverflowRecoveryTestAgent", room);
      const agent = (await getAgentByName(
        env.OverflowRecoveryTestAgent,
        room
      )) as unknown as OverflowAgent;

      // Skip initial connect frames, then enable recovery + seed history on the
      // same DO instance the WebSocket turn will run on.
      await collectMessages(ws, 3);
      await agent.enableOverflowRecoveryForWsTest();

      const done = waitForDone(ws, 15000);
      sendChatRequest(ws, "trigger overflow");
      const messages = await done;

      // The turn must NOT terminate prematurely mid-recovery: no error frame at
      // all, and the single done frame is clean (this is the regression guard
      // for the _streamResult `finally` emitting a spurious done on the overflow
      // early-return).
      const errorFrame = messages.find(
        (m) => m.type === MSG_CHAT_RESPONSE && m.error === true
      );
      expect(errorFrame).toBeUndefined();
      const doneFrames = messages.filter(
        (m) => m.type === MSG_CHAT_RESPONSE && m.done === true
      );
      expect(doneFrames.length).toBe(1);
      expect(doneFrames[0].error).toBeFalsy();

      // The recompacted retry's text actually streamed to the client.
      const hasRecoveredText = messages.some(
        (m) =>
          typeof m.body === "string" &&
          m.body.includes("recovered after compaction")
      );
      expect(hasRecoveredText).toBe(true);

      const stats = await agent.getOverflowStats();
      expect(stats.modelCalls).toBe(2);
      expect(stats.compactionCount).toBe(1);
      expect(stats.compactionEvents).toBe(1);

      await closeWS(ws);
    });

    it("proactive guard compacts mid-turn before the budget is exceeded", async () => {
      const room = crypto.randomUUID();
      const agent = (await getAgentByName(
        env.OverflowRecoveryTestAgent,
        room
      )) as unknown as OverflowAgent;

      const result = await agent.testProactive("use the echo tool");

      // The guard fires before the second step (prior step usage crossed the
      // budget), compacts in place, and the turn completes without a provider
      // overflow error ever surfacing.
      expect(result.error).toBeUndefined();
      expect(result.done).toBe(true);
      expect(result.compactionCount).toBeGreaterThanOrEqual(1);
      // Capped at contextOverflow.maxRetries (1): the guard compacts at most
      // once per run even across multiple steps.
      expect(result.compactionEvents).toBe(1);
    });
  });

  describe("defaultContextOverflowClassifier", () => {
    it("classifies common provider context-overflow errors", () => {
      const overflowMessages = [
        "AI_APICallError: prompt is too long: 213450 tokens > 200000 maximum", // Anthropic
        "This model's maximum context length is 128000 tokens", // OpenAI
        "context_length_exceeded", // OpenAI code
        "The input token count exceeds the maximum number of tokens allowed", // Google
        "Input is too long for requested model", // Bedrock
        "too many tokens"
      ];
      for (const message of overflowMessages) {
        expect(defaultContextOverflowClassifier(new Error(message))).toBe(
          "context_overflow"
        );
        // Also accepts a raw string (the in-stream error shape).
        expect(defaultContextOverflowClassifier(message)).toBe(
          "context_overflow"
        );
      }
    });

    it("returns undefined for unrelated errors", () => {
      expect(
        defaultContextOverflowClassifier(new Error("rate limit exceeded"))
      ).toBeUndefined();
      expect(
        defaultContextOverflowClassifier(new Error("network timeout"))
      ).toBeUndefined();
      expect(defaultContextOverflowClassifier(undefined)).toBeUndefined();
      expect(
        defaultContextOverflowClassifier({ weird: "object" })
      ).toBeUndefined();
    });
  });

  describe("context assembly", () => {
    it("converts messages to model format", async () => {
      const room = crypto.randomUUID();
      const { ws } = await connectWS("LoopTestAgent", room);
      const agent = await getAgentByName(env.LoopTestAgent, room);

      // Skip initial messages
      await collectMessages(ws, 3);

      const done = waitForDone(ws);
      sendChatRequest(ws, "Hello for context test");
      await done;

      await collectMessages(ws, 1, 2000);

      const msgs = (await (
        agent as unknown as { getMessages(): Promise<UIMessage[]> }
      ).getMessages()) as UIMessage[];
      expect(msgs.length).toBeGreaterThanOrEqual(2);

      const userMsg = msgs.find((m) => m.role === "user");
      expect(userMsg).toBeDefined();
      expect(userMsg!.parts).toBeDefined();

      await closeWS(ws);
    });
  });
});
