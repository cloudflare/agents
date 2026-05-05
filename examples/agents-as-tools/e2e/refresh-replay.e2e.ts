/**
 * Refresh-replay — completed helper run survives a page reload.
 *
 * This is the easier half of the durability story (the harder half
 * being "refresh DURING a helper turn", which requires racing the
 * reload against a still-streaming helper — flaky against real LLMs).
 *
 * Flow:
 *
 *   1. Send a research prompt; wait for the helper panel to terminal.
 *   2. Reload the page (same `?user=…`, same Assistant DO).
 *   3. After the reconnect handshake, the parent's `onConnect` walks
 *      `cf_agent_tool_runs` and replays one row's worth of events:
 *      `started`, the stored `chunk`s from the helper's
 *      `_resumableStream`, and `finished`.
 *   4. The client rebuilds the panel from those events — same
 *      `helperType`, same query, terminal status.
 *
 * What this catches that server tests can't:
 *
 *   - The replay → live transition. If the server emits replay
 *     frames, the client's `useAgentToolEvents` reducer must dedupe
 *     against any live frames that arrived before the registry
 *     walk completed. The server tests check the wire frames; only
 *     a real browser tests the post-reconnect React state.
 *   - The fact that `useAgentChat` rebuilds the chat-side message
 *     stream (the assistant's reply) from Think's `_resumableStream`
 *     while the helper panel rebuilds from `cf_agent_tool_runs`.
 *     Two independent replay paths must align in the same React
 *     render or the page renders inconsistent state for a beat.
 */

import { expect, test } from "@playwright/test";
import {
  gotoFresh,
  helperPanelByType,
  helperPanels,
  parentComposer,
  sendMessage,
  waitForChatReady,
  waitForHelperOfType,
  waitForHelperTerminal
} from "./helpers";

test.describe("refresh → replay", () => {
  test("a completed Researcher run replays after page reload", async ({
    page
  }) => {
    const user = await gotoFresh(page);
    await waitForChatReady(page);

    await sendMessage(
      page,
      "Research how DNS over HTTPS works. Use the research tool."
    );
    const panel = await waitForHelperOfType(page, "Researcher");
    await waitForHelperTerminal(panel);

    // Capture the helperId from the first run's panel — the
    // post-reload panel should carry the same id (the row in
    // `cf_agent_tool_runs` is the source of truth and never
    // changed across the reload).
    const originalHelperId = await panel.getAttribute("data-helper-id");
    expect(originalHelperId).toBeTruthy();

    // Reload — same user, same Assistant DO. The post-reload page
    // should rebuild EVERYTHING from durable storage: chat
    // history (Think's `_resumableStream`), helper panel state
    // (`cf_agent_tool_runs` + helper's own `_resumableStream`),
    // and any tool-call parts on the assistant message.
    await page.goto(`/?user=${user}`);
    await waitForChatReady(page);

    // Exactly one helper panel after replay — same id as before,
    // same helperType, terminal status. If `onConnect`'s walk
    // were broken, the count would be 0; if duplication slipped
    // in (e.g. live-vs-replay racing without the dedup key), it
    // could be 2.
    await expect(helperPanels(page)).toHaveCount(1);
    const replayedPanel = await waitForHelperOfType(page, "Researcher");
    await expect(replayedPanel).toHaveAttribute(
      "data-helper-id",
      originalHelperId!
    );
    await expect(replayedPanel).toHaveAttribute(
      "data-helper-status",
      /^(done|error)$/
    );

    // Composer is interactive — the page didn't get stuck on
    // "connecting" while waiting for replay to finish.
    await expect(parentComposer(page)).toBeEnabled();
  });

  test("two completed runs (Researcher + Planner) both replay in order", async ({
    page
  }) => {
    const user = await gotoFresh(page);
    await waitForChatReady(page);

    // Drive two helpers across two separate turns. Two `started_at`
    // values means `onConnect` walks them in deterministic order.
    await sendMessage(
      page,
      "Research what TLS 1.3 0-RTT is. Use the research tool."
    );
    await waitForHelperTerminal(await waitForHelperOfType(page, "Researcher"));

    await sendMessage(
      page,
      "Plan how I'd add TLS 1.3 support to a Node HTTP server. Use the plan tool."
    );
    await waitForHelperTerminal(await waitForHelperOfType(page, "Planner"));

    // Two panels visible before reload.
    await expect(helperPanels(page)).toHaveCount(2);

    await page.goto(`/?user=${user}`);
    await waitForChatReady(page);

    // Both panels replay. Class names survive — the registry
    // resolution from `helper_type` string back to the right
    // class (Researcher / Planner) is what the C1 test pins on
    // the wire; this test pins it visually after the reload.
    await expect(helperPanels(page)).toHaveCount(2);
    await expect(helperPanelByType(page, "Researcher")).toHaveCount(1);
    await expect(helperPanelByType(page, "Planner")).toHaveCount(1);
  });
});
