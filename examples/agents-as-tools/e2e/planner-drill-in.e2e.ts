/**
 * Planner drill-in regression test (e9c0e0ff).
 *
 * The bug: `<DrillInPanel>`'s `useAgent({ sub: [{ agent: "Researcher", ... }] })`
 * had `agent` hardcoded to "Researcher". For Researcher panels this
 * worked by coincidence; for Planner panels, drill-in routed to a
 * fresh empty Researcher facet (because `onBeforeSubAgent` was open
 * at the time, which let any helperId resolve to a fresh DO) and
 * the side panel hung on "Connecting to helper…" with no surfaced
 * cause.
 *
 * Two layers of defense now exist:
 *
 *   1. The fix itself: `agent: helperType`, so the Planner panel
 *      routes to a Planner facet.
 *   2. The C2 safety net: `KNOWN_HELPER_TYPES` validation in
 *      `<DrillInPanel>` rejects unknown helperTypes with an explicit
 *      error state instead of the silent hang.
 *   3. The E4 gate: `Assistant.onBeforeSubAgent` returns 404 for
 *      a `(helperType, helperId)` pair not in `cf_agent_tool_runs`,
 *      so even an attacker with the right helperId but the wrong
 *      helperType is blocked at the framework boundary.
 *
 * This test pins layer 1 — the actual happy-path routing. Layer 2
 * is covered by `cancellation-and-gate.test.ts` (E4) and a unit-
 * level expectation that the unknown-class branch renders the
 * error state. Layer 3 is also in `cancellation-and-gate.test.ts`.
 */

import { expect, test } from "@playwright/test";
import {
  drillInPanel,
  gotoFresh,
  openDrillIn,
  sendMessage,
  waitForChatReady,
  waitForHelperOfType,
  waitForHelperTerminal
} from "./helpers";

test.beforeEach(async ({ page }) => {
  await gotoFresh(page);
  await waitForChatReady(page);
});

test.describe("plan → drill-in (e9c0e0ff regression)", () => {
  test("plan prompt spawns a Planner panel; drill-in connects to a Planner facet, NOT a fresh Researcher", async ({
    page
  }) => {
    // Bias the LLM hard toward `plan`. The system prompt nudges it
    // for "implement / build / refactor" verbiage; "Plan how I'd"
    // is in-distribution.
    await sendMessage(
      page,
      "Plan how I'd add a dark mode toggle to the settings page. Use the plan tool."
    );

    const panel = await waitForHelperOfType(page, "Planner");
    await waitForHelperTerminal(panel);

    // Sanity: a Planner panel rendered. The bug would have NOT
    // affected the panel itself — `helperType` is on the started
    // event from the parent, which is wired correctly. The bug is
    // strictly in the side panel below.
    await expect(panel).toHaveAttribute("data-helper-type", "Planner");

    // Drill in. Without the e9c0e0ff fix, this would route to a
    // Researcher facet (`agent: "Researcher"` hardcoded) and the
    // side panel would hang on "Connecting to helper…".
    await openDrillIn(panel);

    const side = drillInPanel(page);
    await expect(side).toBeVisible();

    // The data-drill-in-helper-type attr is the smoking gun.
    // Without the fix: the React tree still renders with
    // `helperType="Planner"` PROP, so the attribute would show
    // "Planner" — but the underlying `useAgent` call would route
    // to Researcher. To distinguish, we also assert messages
    // render (the side panel's `messages` array is non-empty),
    // which only happens if the helper actually has chat history,
    // which only happens if we routed to the right facet.
    await expect(side).toHaveAttribute("data-drill-in-helper-type", "Planner");

    // Strong post-fix signal: the Planner facet has at least one
    // assistant message (from the turn the parent just drove).
    // Without the fix, a fresh empty Researcher facet would
    // render the empty "Connecting to helper…" state instead.
    await expect(side.getByText(/Connecting to helper/)).toHaveCount(0, {
      timeout: 30_000
    });
    await expect(side.getByText(/^assistant$/)).toBeVisible({
      timeout: 30_000
    });

    // C2 safety net: the unknown-helper-class fallback should NOT
    // render here (Planner is in `KNOWN_HELPER_TYPES`).
    await expect(side.getByText(/Unknown helper class/)).toHaveCount(0);
  });
});
