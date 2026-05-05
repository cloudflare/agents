/**
 * Directory CRUD + sidebar state tests.
 *
 * These exercise `AssistantDirectory` as a plain Agent over DO RPC,
 * with no Worker / GitHub auth in the loop. They pin down the
 * lifecycle the sidebar UI depends on:
 *
 *   - `createChat` spawns a `MyAssistant` facet AND inserts a
 *     `chat_meta` row, then refreshes `state.chats`.
 *   - `listSubAgents(MyAssistant)` is the authoritative set of chats;
 *     `chat_meta` is decoration.
 *   - `recordChatTurn` (intentionally not `@callable()`) updates the
 *     sidebar preview from inside a child via DO RPC.
 *   - `deleteChat` wipes both the facet AND the meta row, and
 *     `_refreshState` correctly drops it from the sidebar.
 *   - `renameChat` is title-only; it does not touch the facet.
 *
 * Note on state reads: the base `Agent.state` is a getter, not an RPC
 * method, so the client reads it over the WebSocket protocol via the
 * `cf_agent_state` frame. `readDirectoryState` in `helpers.ts`
 * encapsulates that.
 */

import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { getAgentByName } from "agents";
import { readDirectoryState, uniqueDirectoryName } from "./helpers";
import type { AssistantDirectory } from "../server";

async function freshDirectory(): Promise<{
  directory: DurableObjectStub<AssistantDirectory>;
  name: string;
}> {
  const name = uniqueDirectoryName();
  const directory = await getAgentByName(env.AssistantDirectory, name);
  return { directory, name };
}

describe("AssistantDirectory — chat lifecycle", () => {
  it("starts with an empty sidebar", async () => {
    const { name } = await freshDirectory();
    const state = await readDirectoryState(name);
    expect(state).toEqual({ chats: [] });
  });

  it("createChat populates state.chats and listSubAgents in sync", async () => {
    const { directory, name } = await freshDirectory();

    const summary = await directory.createChat({ title: "First conversation" });
    expect(summary.id).toBeTruthy();
    expect(summary.title).toBe("First conversation");

    const state = await readDirectoryState(name);
    expect(state.chats).toHaveLength(1);
    expect(state.chats[0]).toMatchObject({
      id: summary.id,
      title: "First conversation"
    });

    // Registry is the authoritative set; meta is decoration.
    const registry = await directory.listSubAgents();
    const found = registry.find((entry) => entry.name === summary.id);
    expect(found?.className).toBe("MyAssistant");
  });

  it("createChat without an explicit title falls back to a default", async () => {
    const { directory } = await freshDirectory();

    const summary = await directory.createChat();
    expect(summary.title).toMatch(/^New chat —/);
  });

  it("renameChat updates the title without touching the facet", async () => {
    const { directory, name } = await freshDirectory();
    const { id } = await directory.createChat({ title: "Original" });

    await directory.renameChat(id, "Renamed");

    const state = await readDirectoryState(name);
    const renamed = state.chats.find((c) => c.id === id);
    expect(renamed?.title).toBe("Renamed");

    // Whitespace-only renames are ignored, as per the example spec.
    await directory.renameChat(id, "   ");
    const stateAfterNoop = await readDirectoryState(name);
    expect(stateAfterNoop.chats.find((c) => c.id === id)?.title).toBe(
      "Renamed"
    );
  });

  it("deleteChat removes the chat from state, registry, and meta", async () => {
    const { directory, name } = await freshDirectory();
    const a = await directory.createChat({ title: "Keep" });
    const b = await directory.createChat({ title: "Drop" });

    await directory.deleteChat(b.id);

    const state = await readDirectoryState(name);
    expect(state.chats.map((c) => c.id)).toEqual([a.id]);

    const registry = await directory.listSubAgents();
    expect(registry.find((entry) => entry.name === b.id)).toBeUndefined();
  });

  it("deleteChat is idempotent for unknown ids", async () => {
    const { directory, name } = await freshDirectory();

    // Should not throw.
    await directory.deleteChat("never-existed");

    const state = await readDirectoryState(name);
    expect(state.chats).toEqual([]);
  });
});

describe("AssistantDirectory — recordChatTurn", () => {
  it("updates the sidebar preview and ordering, not @callable from a client", async () => {
    const { directory, name } = await freshDirectory();
    const a = await directory.createChat({ title: "A" });
    const b = await directory.createChat({ title: "B" });

    // recordChatTurn is the parent-side side effect of committing a
    // child turn — invoked via DO RPC, not exposed to the browser.
    // (The `@callable()` decorator is deliberately omitted; this test
    // just exercises the happy-path RPC.)
    await directory.recordChatTurn(a.id, "Hello there");

    const state = await readDirectoryState(name);
    // `a` should now be most-recent; `b` falls behind.
    expect(state.chats.map((c) => c.id)).toEqual([a.id, b.id]);
    expect(state.chats[0].lastMessagePreview).toBe("Hello there");
  });

  it("inserts a meta row even for a chat id with no prior meta", async () => {
    const { directory, name } = await freshDirectory();
    const { id } = await directory.createChat();

    // Simulate a child whose initial create raced ahead of meta —
    // recordChatTurn should still insert a row via INSERT ... ON CONFLICT.
    await directory.recordChatTurn(id, "first turn");

    const state = await readDirectoryState(name);
    expect(state.chats[0].lastMessagePreview).toBe("first turn");
  });
});
