/**
 * Coverage for issue #1873: a Think turn must have a supported server-side path
 * to write metadata onto the assistant message it persists.
 *
 * Base `AIChatAgent` + `streamText` already support the AI SDK `messageMetadata`
 * callback, but `Think` wrapped the provider stream and forwarded only
 * `{ sendReasoning, onError }`, so the callback was dropped on the way through
 * `toUIMessageStream`. Think now forwards a `messageMetadata` writer — set on
 * the instance or overridden per turn via `TurnConfig` — so a turn can stamp
 * structured metadata (e.g. a `createdAt` timestamp) onto the assistant message.
 *
 * The test agent (`ThinkClientToolsAgent`) stamps `scope: "turn"` from the
 * per-turn writer and `scope: "instance"` from the instance-level writer, so the
 * precedence test can tell which one ran.
 */

import { env, exports } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { getAgentByName } from "agents";
import type { UIMessage } from "ai";

const MSG_CHAT_REQUEST = "cf_agent_use_chat_request";
const MSG_CHAT_RESPONSE = "cf_agent_use_chat_response";

async function connectWS(room: string): Promise<WebSocket> {
  const res = await exports.default.fetch(
    `http://example.com/agents/think-client-tools-agent/${room}`,
    { headers: { Upgrade: "websocket" } }
  );
  expect(res.status).toBe(101);
  const ws = res.webSocket as WebSocket;
  expect(ws).toBeDefined();
  ws.accept();
  return ws;
}

/** Drive a single user turn and resolve once the server signals `done`. */
function runTurn(ws: WebSocket, text: string, timeout = 10_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Timeout waiting for done")),
      timeout
    );
    const handler = (e: MessageEvent) => {
      try {
        const msg = JSON.parse(e.data as string) as Record<string, unknown>;
        if (msg.type !== MSG_CHAT_RESPONSE) return;
        if (msg.done === true) {
          clearTimeout(timer);
          ws.removeEventListener("message", handler);
          resolve();
        }
      } catch {
        // ignore non-JSON frames
      }
    };
    ws.addEventListener("message", handler);

    ws.send(
      JSON.stringify({
        type: MSG_CHAT_REQUEST,
        id: crypto.randomUUID(),
        init: {
          method: "POST",
          body: JSON.stringify({
            messages: [
              {
                id: crypto.randomUUID(),
                role: "user",
                parts: [{ type: "text", text }]
              }
            ]
          })
        }
      })
    );
  });
}

/**
 * Wait for the persisted assistant message. The `done` broadcast lands BEFORE
 * the row is durably persisted, so poll instead of betting on a fixed sleep.
 */
async function waitForAssistant(agent: {
  getMessages(): Promise<unknown>;
}): Promise<UIMessage> {
  return vi.waitFor(
    async () => {
      const messages = (await agent.getMessages()) as UIMessage[];
      const persisted = messages.find((m) => m.role === "assistant");
      expect(persisted).toBeDefined();
      return persisted as UIMessage;
    },
    { timeout: 8000, interval: 25 }
  );
}

describe("Think — server-authored assistant-message metadata", () => {
  it(
    "forwards TurnConfig.messageMetadata onto the persisted assistant message, merging start and finish parts",
    { timeout: 15_000 },
    async () => {
      const room = crypto.randomUUID();
      const agent = await getAgentByName(env.ThinkClientToolsAgent, room);
      await agent.setTextOnlyMode(true);
      await agent.setMessageMetadataMode(true);
      const ws = await connectWS(room);

      await runTurn(ws, "hello");

      const assistant = await waitForAssistant(agent);
      // `createdAt`/`scope` come from the `start` part and `source` from
      // `finish`; all three surviving proves the parts are shallow-merged, not
      // clobbered.
      const metadata = assistant.metadata as Record<string, unknown>;
      expect(metadata.createdAt).toBe(1_700_000_000_000);
      expect(metadata.scope).toBe("turn");
      expect(metadata.source).toBe("server");

      ws.close(1000);
    }
  );

  it(
    "applies the instance-level messageMetadata property with no per-turn override",
    { timeout: 15_000 },
    async () => {
      const room = crypto.randomUUID();
      const agent = await getAgentByName(env.ThinkClientToolsAgent, room);
      await agent.setTextOnlyMode(true);
      await agent.setInstanceMessageMetadataMode(true);
      const ws = await connectWS(room);

      await runTurn(ws, "hello");

      const assistant = await waitForAssistant(agent);
      const metadata = assistant.metadata as Record<string, unknown>;
      expect(metadata.scope).toBe("instance");
      expect(metadata.createdAt).toBe(1_600_000_000_000);

      ws.close(1000);
    }
  );

  it(
    "lets a per-turn TurnConfig.messageMetadata override the instance-level writer",
    { timeout: 15_000 },
    async () => {
      const room = crypto.randomUUID();
      const agent = await getAgentByName(env.ThinkClientToolsAgent, room);
      await agent.setTextOnlyMode(true);
      // Both writers active: `config.messageMetadata ?? this.messageMetadata`
      // must resolve to the per-turn one.
      await agent.setInstanceMessageMetadataMode(true);
      await agent.setMessageMetadataMode(true);
      const ws = await connectWS(room);

      await runTurn(ws, "hello");

      const assistant = await waitForAssistant(agent);
      const metadata = assistant.metadata as Record<string, unknown>;
      expect(metadata.scope).toBe("turn");
      expect(metadata.createdAt).toBe(1_700_000_000_000);

      ws.close(1000);
    }
  );

  it(
    "stamps no metadata keys when no writer is configured (opt-in)",
    { timeout: 15_000 },
    async () => {
      const room = crypto.randomUUID();
      const agent = await getAgentByName(env.ThinkClientToolsAgent, room);
      await agent.setTextOnlyMode(true);
      const ws = await connectWS(room);

      await runTurn(ws, "hello");

      const assistant = await waitForAssistant(agent);
      // The writer is opt-in: Think must not fabricate our fields on its own.
      const metadata = (assistant.metadata ?? {}) as Record<string, unknown>;
      expect(metadata.createdAt).toBeUndefined();
      expect(metadata.scope).toBeUndefined();

      ws.close(1000);
    }
  );
});
