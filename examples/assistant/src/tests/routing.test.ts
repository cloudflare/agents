/**
 * Routing tests for `AssistantDirectory.onBeforeSubAgent`.
 *
 * The directory uses `hasSubAgent` as a strict-registry gate: any
 * incoming `/sub/my-assistant/<id>` request for a chat id that hasn't been
 * spawned via `createChat` must short-circuit with a 404 before
 * Agent routing wakes the child. This is the example's primary
 * defense against a client guessing chat ids inside its own directory.
 *
 * URL shape under test:
 *   /agents/assistant-directory/<user>/sub/my-assistant/<chat-id>
 */

import { exports, env } from "cloudflare:workers";
import { createExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { camelCaseToKebabCase, getAgentByName } from "agents";
import { AssistantDirectory } from "../../agents/assistant/agent";
import { MyAssistant } from "../../agents/assistant/agents/my-assistant/agent";
import assistantWorker from "../server";
import { uniqueDirectoryName } from "./helpers";

function subAgentPath(directory: string, chatId: string): string {
  const child = camelCaseToKebabCase(MyAssistant.name);
  return `/agents/assistant-directory/${directory}/sub/${child}/${chatId}`;
}

describe("AssistantDirectory — onBeforeSubAgent strict-registry gate", () => {
  it("uses readable root and facet runtime class names", () => {
    expect(AssistantDirectory.name).toBe("AssistantDirectory");
    expect(MyAssistant.name).toBe("MyAssistant");
  });

  it("routes the directory URL through the explicit Worker entry", async () => {
    const res = await assistantWorker.fetch(
      new Request("http://example.com/chat", {
        headers: { Upgrade: "websocket" }
      }),
      env,
      createExecutionContext()
    );

    expect(res.status).toBe(101);
    res.webSocket?.accept();
    res.webSocket?.close();
  });

  it("routes the friendly chat URL through the explicit Worker entry", async () => {
    const directory = await getAgentByName(
      env.AssistantDirectory,
      env.DEV_USER
    );
    const { id } = await directory.createChat({ title: "Explicit route" });

    const res = await assistantWorker.fetch(
      new Request(`http://example.com/chat/sub/my-assistant/${id}`, {
        headers: { Upgrade: "websocket" }
      }),
      env,
      createExecutionContext()
    );

    expect(res.status).toBe(101);
    res.webSocket?.accept();
    res.webSocket?.close();
  });

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
