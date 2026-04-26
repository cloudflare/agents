/**
 * Daily-summary fan-out test.
 *
 * `AssistantDirectory.dailySummary` runs on a parent-side cron
 * because facets can't `schedule()` (workerd limitation). It picks
 * the most-recently-updated chat from `chat_meta` and queues a prompt
 * into that child via
 * `subAgent(MyAssistant, id).postDailySummaryPrompt()`.
 *
 * Scope note: a full round-trip test would have to invoke
 * `postDailySummaryPrompt` to completion. That calls `saveMessages`,
 * which in turn fires Think's auto-resume fiber → `getModel()` →
 * `createWorkersAI({ binding: env.AI })`. We deliberately don't bind
 * `AI` in the test wrangler (see `wrangler.jsonc` for why), so we
 * scope these tests to the no-op path and the ordering precondition
 * the dispatcher relies on. The framework's own Think tests cover
 * the `saveMessages` → turn pipeline in detail.
 */

import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { getAgentByName } from "agents";
import { readDirectoryState, uniqueDirectoryName } from "./helpers";

describe("AssistantDirectory.dailySummary", () => {
  it("is a no-op when no chats exist", async () => {
    const directory = await getAgentByName(
      env.AssistantDirectory,
      uniqueDirectoryName()
    );

    // Resolves cleanly without spawning anything.
    await directory.dailySummary();

    expect((await directory.listSubAgents()).length).toBe(0);
  });

  it("ordering: chat_meta is sorted most-recently-updated first", async () => {
    // dailySummary picks `chat_meta[0].id` after ORDER BY updated_at
    // DESC. We verify the ordering precondition holds — the actual
    // dispatch into the child is gated on the AI binding (see scope
    // note above).
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
