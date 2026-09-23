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
const MSG_TOOL_APPROVAL = "cf_agent_tool_approval";

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

/**
 * Drive a single user turn and resolve once the server signals `done`, with the
 * UI-message chunks broadcast to the client along the way.
 */
function runTurn(
  ws: WebSocket,
  text: string,
  extraBody?: Record<string, unknown>,
  timeout = 10_000
): Promise<Array<Record<string, unknown>>> {
  return new Promise((resolve, reject) => {
    const chunks: Array<Record<string, unknown>> = [];
    const timer = setTimeout(
      () => reject(new Error("Timeout waiting for done")),
      timeout
    );
    const handler = (e: MessageEvent) => {
      try {
        const msg = JSON.parse(e.data as string) as Record<string, unknown>;
        if (msg.type !== MSG_CHAT_RESPONSE) return;
        if (typeof msg.body === "string" && msg.body.length > 0) {
          chunks.push(JSON.parse(msg.body) as Record<string, unknown>);
        }
        if (msg.done === true) {
          clearTimeout(timer);
          ws.removeEventListener("message", handler);
          resolve(chunks);
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
            ],
            ...extraBody
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
    "broadcasts the metadata on the live start/finish chunks so the client sees it while streaming",
    { timeout: 15_000 },
    async () => {
      const room = crypto.randomUUID();
      const agent = await getAgentByName(env.ThinkClientToolsAgent, room);
      await agent.setTextOnlyMode(true);
      await agent.setMessageMetadataMode(true);
      const ws = await connectWS(room);

      const chunks = await runTurn(ws, "hello");

      const start = chunks.find((c) => c.type === "start");
      const finish = chunks.find((c) => c.type === "finish");
      expect(start?.messageMetadata).toEqual({
        createdAt: 1_700_000_000_000,
        scope: "turn"
      });
      expect(finish?.messageMetadata).toEqual({ source: "server" });

      ws.close(1000);
    }
  );

  it(
    "resolves the writer again for a continuation turn, which persists its own assistant message",
    { timeout: 20_000 },
    async () => {
      const room = crypto.randomUUID();
      const agent = await getAgentByName(env.ThinkClientToolsAgent, room);
      await agent.setMessageMetadataMode(true);
      await agent.setServerApprovalToolMode(true);
      const ws = await connectWS(room);

      await runTurn(ws, "update my trigger");
      const first = await waitForAssistant(agent);

      const continuationDone = new Promise<void>((resolve) => {
        const handler = (e: MessageEvent) => {
          const msg = JSON.parse(e.data as string) as Record<string, unknown>;
          if (msg.type === MSG_CHAT_RESPONSE && msg.done === true) {
            ws.removeEventListener("message", handler);
            resolve();
          }
        };
        ws.addEventListener("message", handler);
      });
      ws.send(
        JSON.stringify({
          type: MSG_TOOL_APPROVAL,
          toolCallId: "tc-server-approval-1",
          approved: true,
          autoContinue: true
        })
      );
      await continuationDone;

      await vi.waitFor(
        async () => {
          const messages = (await agent.getMessages()) as UIMessage[];
          const assistants = messages.filter((m) => m.role === "assistant");
          expect(assistants).toHaveLength(2);
          expect(assistants[0].id).toBe(first.id);
          expect(assistants[0].metadata).toEqual({
            createdAt: 1_700_000_000_000,
            scope: "turn",
            source: "server"
          });
          expect(assistants[1].metadata).toEqual({
            continued: true,
            source: "server"
          });
        },
        { timeout: 8000, interval: 25 }
      );

      ws.close(1000);
    }
  );

  it(
    "writes metadata on the sub-agent chat() RPC path too",
    { timeout: 15_000 },
    async () => {
      const agent = await getAgentByName(
        env.ThinkClientToolsAgent,
        crypto.randomUUID()
      );
      await agent.setTextOnlyMode(true);
      await agent.setMessageMetadataMode(true);

      const { startMetadataJson, metadataJson } =
        await agent.runChatForMetadata("hello");

      expect(JSON.parse(startMetadataJson ?? "null")).toEqual({
        createdAt: 1_700_000_000_000,
        scope: "turn"
      });
      expect(JSON.parse(metadataJson ?? "null")).toEqual({
        createdAt: 1_700_000_000_000,
        scope: "turn",
        source: "server"
      });
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
