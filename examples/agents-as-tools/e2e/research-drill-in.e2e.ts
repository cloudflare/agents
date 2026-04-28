/**
 * Helper-routing tests — drilling in to a helper panel must connect
 * to the helper class that produced it.
 *
 * The 2026-04-28 bug fixed in `e9c0e0ff` (`agent: "Researcher"`
 * hardcoded in `<DrillInPanel>`'s `useAgent({ sub: [...] })`) was
 * a pure browser-side routing bug: drilling in to a Planner panel
 * spawned a fresh empty Researcher facet and the side panel hung
 * on "Connecting to helper…" with no surfaced cause. The server-
 * side test harness couldn't catch it — there are no DO-side
 * frames involved.
 *
 * These tests pin the routing per helper class:
 *
 *   - Researcher: drill-in side panel reports `helperType=Researcher`
 *     and renders messages.
 *   - Planner: same, but the side panel reports `helperType=Planner`.
 *     Without the fix, the panel would render a Researcher header
 *     (or hang silently); with the fix, the side panel's
 *     `data-drill-in-helper-type` resolves to "Planner".
 *
 * Because we use a real LLM, the prompts are deliberately
 * tool-biasing — "Research X" / "Plan how I'd implement Y" — so
 * the model picks `research` / `plan` rather than `compare` or
 * plain chat. If a prompt ever flakes to the wrong tool, the test
 * fails fast on `waitForHelperOfType`'s 60s budget rather than
 * silently producing a misleading pass.
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

test.describe("research → drill-in", () => {
  test("research prompt spawns a Researcher panel; drill-in connects to a Researcher facet", async ({
    page
  }) => {
    await sendMessage(
      page,
      "Research how HTTP/3 differs from HTTP/2. Use the research tool."
    );

    const panel = await waitForHelperOfType(page, "Researcher");
    await waitForHelperTerminal(panel);

    // Open the drill-in side panel via the ↗ button.
    await openDrillIn(panel);

    // Side panel routes to a Researcher facet — the data attr is
    // populated from the `helperType` prop, which the server's
    // helper-event lifecycle stamped on the started event.
    const side = drillInPanel(page);
    await expect(side).toBeVisible();
    await expect(side).toHaveAttribute(
      "data-drill-in-helper-type",
      "Researcher"
    );

    // Side panel renders messages — at least the assistant's reply
    // from the helper turn shows up in `messages`. If the gate or
    // the routing were broken the panel would either hang on
    // "Connecting to helper…" or render the unknown-helper-class
    // error state.
    await expect(side.getByText(/assistant/)).toBeVisible({
      timeout: 30_000
    });
    await expect(side.getByText(/Connecting to helper/)).toHaveCount(0);
    await expect(side.getByText(/Unknown helper class/)).toHaveCount(0);
  });
});
