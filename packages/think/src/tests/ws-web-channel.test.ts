/**
 * Regression coverage for #2255: WebSocket chat turns run on the implicit
 * `web` channel, so a `web` entry in `configureChannels()` applies to them.
 */

import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { getAgentByName } from "agents";
import type { UIMessage } from "ai";
import type { ThinkTestAgent } from "./agents/think-session";

const MSG_CHAT_REQUEST = "cf_agent_use_chat_request";
const MSG_CHAT_RESPONSE = "cf_agent_use_chat_response";

async function freshAgent() {
  const room = crypto.randomUUID();
  const agent = await getAgentByName(
    env.ThinkTestAgent as unknown as DurableObjectNamespace<ThinkTestAgent>,
    room
  );
  const res = await exports.default.fetch(
    `http://example.com/agents/think-test-agent/${room}`,
    { headers: { Upgrade: "websocket" } }
  );
  expect(res.status).toBe(101);
  const ws = res.webSocket as WebSocket;
  ws.accept();
  return { agent, ws };
}

function userMessage(
  text: string,
  metadata?: Record<string, unknown>
): UIMessage {
  return {
    id: crypto.randomUUID(),
    role: "user",
    parts: [{ type: "text", text }],
    ...(metadata ? { metadata } : {})
  };
}

/** Sends a chat request and resolves once its terminal `done` frame arrives. */
function sendChat(
  ws: WebSocket,
  messages: UIMessage[],
  trigger?: string
): Promise<void> {
  const id = crypto.randomUUID();
  const done = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Timeout waiting for done")),
      10_000
    );
    const handler = (e: MessageEvent) => {
      const msg = JSON.parse(e.data as string) as Record<string, unknown>;
      if (msg.type === MSG_CHAT_RESPONSE && msg.id === id && msg.done) {
        clearTimeout(timer);
        ws.removeEventListener("message", handler);
        resolve();
      }
    };
    ws.addEventListener("message", handler);
  });
  ws.send(
    JSON.stringify({
      type: MSG_CHAT_REQUEST,
      id,
      init: { method: "POST", body: JSON.stringify({ messages, trigger }) }
    })
  );
  return done;
}

function channelOf(message: UIMessage | undefined): unknown {
  return (message?.metadata as { channel?: unknown } | undefined)?.channel;
}

describe("Think — WebSocket chat runs on the web channel (#2255)", () => {
  it("applies the web channel policy and exposes activeChannel", async () => {
    const { agent, ws } = await freshAgent();

    await sendChat(ws, [userMessage("hello")]);

    expect(await agent.getCapturedTurnChannelsForTest()).toEqual(["web"]);
    const log = await agent.getBeforeTurnLog();
    expect(log.at(-1)?.system).toContain("WEB MODE");
    expect(log.at(-1)?.system).not.toContain("VOICE MODE");
    ws.close();
  });

  it("stamps the web channel on the user message", async () => {
    const { agent, ws } = await freshAgent();

    await sendChat(ws, [userMessage("hello")]);

    const messages = (await agent.getStoredMessages()) as UIMessage[];
    expect(channelOf(messages.find((m) => m.role === "user"))).toBe("web");
    ws.close();
  });

  it("keeps the stamp when the client re-sends the transcript", async () => {
    const { agent, ws } = await freshAgent();
    const first = userMessage("first");

    await sendChat(ws, [first]);
    const afterFirst = (await agent.getStoredMessages()) as UIMessage[];
    const second = userMessage("second");
    // A browser client echoes messages back without server-owned metadata.
    await sendChat(ws, [
      first,
      ...afterFirst.filter((m) => m.role === "assistant"),
      second
    ]);

    const messages = (await agent.getStoredMessages()) as UIMessage[];
    const users = messages.filter((m) => m.role === "user");
    expect(users.map((m) => m.id)).toEqual([first.id, second.id]);
    expect(users.map(channelOf)).toEqual(["web", "web"]);
    expect(await agent.getCapturedTurnChannelsForTest()).toEqual([
      "web",
      "web"
    ]);
    ws.close();
  });

  it("ignores a channel forged in client-sent metadata", async () => {
    const { agent, ws } = await freshAgent();

    await sendChat(ws, [userMessage("hello", { channel: "voice" })]);

    expect(await agent.getCapturedTurnChannelsForTest()).toEqual(["web"]);
    const log = await agent.getBeforeTurnLog();
    expect(log.at(-1)?.system).not.toContain("VOICE MODE");
    const messages = (await agent.getStoredMessages()) as UIMessage[];
    expect(channelOf(messages.find((m) => m.role === "user"))).toBe("web");
    ws.close();
  });

  it("re-resolves the web channel when the turn is continued", async () => {
    const { agent, ws } = await freshAgent();

    await sendChat(ws, [userMessage("hello")]);
    await agent.resetCapturedTurnChannelsForTest();
    await agent.runChannelTurnForTest({ continuation: true });

    expect(await agent.getCapturedTurnChannelsForTest()).toEqual(["web"]);
    ws.close();
  });

  it("continues a regeneration of another channel's message on web", async () => {
    const { agent, ws } = await freshAgent();
    await agent.runChannelTurnForTest({ input: "hello", channel: "voice" });
    const stored = (await agent.getStoredMessages()) as UIMessage[];
    const voiceUser = stored.find((m) => m.role === "user");
    expect(channelOf(voiceUser)).toBe("voice");
    await agent.resetCapturedTurnChannelsForTest();

    await sendChat(
      ws,
      [{ ...voiceUser!, metadata: undefined }],
      "regenerate-message"
    );

    expect(await agent.getCapturedTurnChannelsForTest()).toEqual(["web"]);
    // The stored message keeps the channel it was sent on.
    const messages = (await agent.getStoredMessages()) as UIMessage[];
    expect(channelOf(messages.find((m) => m.id === voiceUser!.id))).toBe(
      "voice"
    );
    // A tool-result continuation extends the web turn, not the voice one.
    expect(await agent.getAutoContinuationChannelForTest()).toBe("web");

    await agent.resetCapturedTurnChannelsForTest();
    await agent.runChannelTurnForTest({ continuation: true });
    expect(await agent.getCapturedTurnChannelsForTest()).toEqual(["web"]);
    ws.close();
  });

  it("extends the channel an explicit-channel continuation ran on", async () => {
    const { agent, ws } = await freshAgent();
    await sendChat(ws, [userMessage("hello")]);

    await agent.runChannelTurnForTest({ continuation: true, channel: "voice" });

    expect(await agent.getAutoContinuationChannelForTest()).toBe("voice");
    ws.close();
  });

  it("still runs server-driven turns without a channel by default", async () => {
    const { agent, ws } = await freshAgent();

    await agent.runChannelTurnForTest({ input: "hello" });

    expect(await agent.getCapturedTurnChannelsForTest()).toEqual([""]);
    const log = await agent.getBeforeTurnLog();
    expect(log.at(-1)?.system).not.toContain("WEB MODE");
    ws.close();
  });
});
