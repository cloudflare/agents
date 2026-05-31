/**
 * Daily-summary scheduled-task test.
 *
 * The directory (`AssistantDirectory`, a Think root used as an accumulator)
 * declares a `dailySummary` scheduled task via `getScheduledTasks()`. Think
 * reconciles declared tasks on startup into a durable one-shot schedule. The
 * task is a deterministic handler that picks the most-recently-updated chat
 * and RPCs a proactive summary prompt into that child.
 *
 * Scope note: we assert reconciliation (a schedule row exists) and the
 * ordering precondition the handler relies on. We don't drive the handler to
 * completion because that fans out into a child `saveMessages` -> turn, which
 * needs the `AI` binding (deliberately unbound here; see `wrangler.jsonc`).
 * The framework's own tests cover scheduled-task execution in detail.
 */

import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { getAgentByName } from "agents";
import { connectWS, readDirectoryState, uniqueDirectoryName } from "./helpers";

describe("AssistantDirectory daily summary", () => {
  it("reconciles the declarative dailySummary scheduled task on startup", async () => {
    const name = uniqueDirectoryName();

    // Warm the directory with a real request so Think's onStart (which
    // reconciles declared scheduled tasks) runs to completion.
    const { ws } = await connectWS(`/agents/assistant-directory/${name}`);
    ws.close();

    const stub = env.AssistantDirectory.get(
      env.AssistantDirectory.idFromName(name)
    );

    // Read the directory's schedules in-process. `_runDeclaredScheduledTask`
    // is the callback Think schedules for each declared task occurrence.
    const callbacks = await runInDurableObject(stub, (instance) =>
      instance.getSchedules().map((schedule) => schedule.callback)
    );

    expect(callbacks).toContain("_runDeclaredScheduledTask");
  });

  it("ordering: chat_meta is sorted most-recently-updated first", async () => {
    // The handler picks `chat_meta[0].id` after ORDER BY updated_at DESC.
    // We verify the ordering precondition holds — the actual dispatch into
    // the child is gated on the AI binding (see scope note above).
    const directoryName = uniqueDirectoryName();
    const directory = await getAgentByName(
      env.AssistantDirectory,
      directoryName
    );

    const a = await directory.createChat({ title: "older" });
    const b = await directory.createChat({ title: "newer" });

    await directory.recordChatTurn(a.id, "first ping");
    await new Promise((resolve) => setTimeout(resolve, 5));
    await directory.recordChatTurn(b.id, "second ping");

    const state = await readDirectoryState(directoryName);
    expect(state.chats[0].id).toBe(b.id);
    expect(state.chats[1].id).toBe(a.id);
  });
});
