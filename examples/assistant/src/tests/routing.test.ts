/**
 * Routing tests for `AssistantDirectory.onBeforeSubAgent`.
 *
 * The directory uses `hasSubAgent` as a strict-registry gate: any
 * incoming `/sub/my-assistant/<id>` request for a chat id that hasn't
 * been spawned via `createChat` must short-circuit with a 404 before
 * the framework wakes the child. This is the example's primary
 * defense against a client guessing chat ids inside its own directory.
 *
 * URL shape under test:
 *   /agents/assistant-directory/<user>/sub/my-assistant/<chat-id>
 */

import { exports, env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { getAgentByName } from "agents";
import { uniqueDirectoryName } from "./helpers";

function subAgentPath(directory: string, chatId: string): string {
  return `/agents/assistant-directory/${directory}/sub/my-assistant/${chatId}`;
}

describe("AssistantDirectory — onBeforeSubAgent strict-registry gate", () => {
  it("rejects a chat id that was never created", async () => {
    const directoryName = uniqueDirectoryName();
    // Prime the directory so `hasSubAgent` runs against its real
    // registry rather than a freshly-spawned one.
    await getAgentByName(env.AssistantDirectory, directoryName);

    const res = await exports.default.fetch(
      `http://example.com${subAgentPath(directoryName, "ghost-chat")}`
    );

    expect(res.status).toBe(404);
    expect(await res.text()).toContain('MyAssistant "ghost-chat" not found');
  });

  it("forwards to the child when the chat was created via createChat", async () => {
    const directoryName = uniqueDirectoryName();
    const directory = await getAgentByName(
      env.AssistantDirectory,
      directoryName
    );
    const { id } = await directory.createChat({ title: "Real chat" });

    // A successful WebSocket upgrade against the sub-agent URL is the
    // cleanest liveness probe: it round-trips through the directory's
    // `onBeforeSubAgent` hook and into the child's connect handler.
    // 404 from the gate would short-circuit the upgrade with an HTTP
    // response instead of a 101.
    const res = await exports.default.fetch(
      `http://example.com${subAgentPath(directoryName, id)}`,
      { headers: { Upgrade: "websocket" } }
    );

    expect(res.status).toBe(101);
    const ws = res.webSocket;
    if (ws) {
      ws.accept();
      ws.close();
    }
  });

  it("rejects a chat id that was created and then deleted", async () => {
    const directoryName = uniqueDirectoryName();
    const directory = await getAgentByName(
      env.AssistantDirectory,
      directoryName
    );
    const { id } = await directory.createChat();
    await directory.deleteChat(id);

    const res = await exports.default.fetch(
      `http://example.com${subAgentPath(directoryName, id)}`
    );
    expect(res.status).toBe(404);
  });
});
