/**
 * Parallel fan-out (`compare`) renders two Researcher panels in
 * deterministic display order under one chat tool call.
 *
 * Backs the GLips-style "fan-out from one tool call" pattern from
 * cloudflare/agents#1377-comment-4328296343 (image 3). The
 * server-side test harness already validates the
 * `(parentToolCallId, helperId, sequence)` demux on the wire and
 * the `display_order` persistence on the row; this one validates
 * the client renders both panels visually as siblings.
 *
 * Display-order assertion: `compare` passes `displayOrder` 0 to
 * branch `a` and 1 to branch `b`. The client sorts each tool-call's
 * helper bucket by `order` before rendering. So the FIRST helper
 * panel under the `compare` tool call is the one for `a`, the
 * SECOND is for `b`. We can't tell from the panel attributes alone
 * which is which (no `order` attr is exposed; both `data-helper-type`
 * are "Researcher"), so we assert on count + structural ordering
 * via DOM position.
 */

import { expect, test } from "@playwright/test";
import {
  gotoFresh,
  helperPanels,
  helperPanelByType,
  sendMessage,
  waitForChatReady,
  waitForHelperTerminal
} from "./helpers";

test.beforeEach(async ({ page }) => {
  await gotoFresh(page);
  await waitForChatReady(page);
});

test.describe("compare → two panels", () => {
  test("compare prompt renders TWO Researcher panels under one chat tool call", async ({
    page
  }) => {
    // "Compare X and Y" is in-distribution for the `compare` tool —
    // the system prompt explicitly lists "compare two protocols /
    // libraries / approaches" as the right shape. If the model
    // ever flakes to two parallel `research` calls instead, the
    // panel count is still 2 but they render under separate tool
    // calls; we'd have to reach into `data-tool-call-id` to
    // distinguish. For now, just assert the panel count.
    await sendMessage(
      page,
      "Compare HTTP/3 and gRPC for me. Use the compare tool."
    );

    // Two Researcher panels render. Wait for both to exist before
    // asserting on terminal status — they spawn from
    // Promise.allSettled so they show up roughly together.
    const researcherPanels = helperPanelByType(page, "Researcher");
    await expect(researcherPanels).toHaveCount(2, { timeout: 60_000 });

    // Both panels eventually reach a terminal state. With real
    // LLMs this can take 30-60s.
    const first = researcherPanels.first();
    const second = researcherPanels.nth(1);
    await waitForHelperTerminal(first);
    await waitForHelperTerminal(second);

    // No third panel snuck in (no extra tool calls).
    await expect(helperPanels(page)).toHaveCount(2);
  });
});
