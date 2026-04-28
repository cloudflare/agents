/**
 * Clear button — wipes both the chat history and the helper-runs
 * registry. After clear, the page should look exactly like a fresh
 * load: no messages, no helper panels.
 *
 * The flow we're verifying is the `clear` callback in `App` that
 * calls `agent.call("clearHelperRuns")` BEFORE `clearHistory()`.
 * If the order were reversed (or `clearHelperRuns` were skipped),
 * a refresh after Clear would resurrect helper panels via
 * `Assistant.onConnect`'s replay path. We catch that with a
 * quick reload at the end.
 */

import { expect, test } from "@playwright/test";
import {
  gotoFresh,
  helperPanels,
  parentComposer,
  sendMessage,
  waitForChatReady,
  waitForHelperOfType,
  waitForHelperTerminal
} from "./helpers";

test.describe("clear", () => {
  test("Clear wipes messages and helper panels, and a reload doesn't bring them back", async ({
    page
  }) => {
    const user = await gotoFresh(page);
    await waitForChatReady(page);

    // Drive a research turn — single helper, fastest of the three
    // helper-dispatching tools to land. Wait for it to fully
    // settle before clearing so we know we're testing "clear an
    // already-completed run", not "clear an in-flight run"
    // (which would also need to validate cancellation; out of
    // scope for this test).
    await sendMessage(
      page,
      "Research what HTTP/2 server push is. Use the research tool."
    );
    const panel = await waitForHelperOfType(page, "Researcher");
    await waitForHelperTerminal(panel);

    // Sanity: panel exists, messages exist, Clear is enabled.
    await expect(helperPanels(page)).toHaveCount(1);
    const clearBtn = page.getByRole("button", { name: "Clear" });
    await expect(clearBtn).toBeEnabled();

    await clearBtn.click();

    // Both surfaces wiped: chat (`messages.length === 0` disables
    // the Clear button as the empty-state signal) AND helper
    // panels (the registry was cleared, so no panel state
    // survives).
    await expect(clearBtn).toBeDisabled();
    await expect(helperPanels(page)).toHaveCount(0);

    // Reload — onConnect reads the registry to rebuild the helper
    // timeline. With Clear having wiped `cf_agent_helper_runs`,
    // the rebuild produces nothing and the page stays empty. If
    // `clearHelperRuns` were a no-op (or were called AFTER
    // `clearHistory`), the panel would replay here.
    await page.goto(`/?user=${user}`);
    await waitForChatReady(page);
    await expect(helperPanels(page)).toHaveCount(0);
    await expect(parentComposer(page)).toBeEnabled();
  });
});
