/**
 * Smoke test — page boots, the WS handshake completes, and the
 * composer becomes interactive.
 *
 * If this fails, every other e2e test will fail too. Keep it tiny
 * so a fresh dev-server hiccup surfaces here rather than as a
 * confusing later assertion timeout.
 */

import { expect, test } from "@playwright/test";
import { gotoFresh, parentComposer, waitForChatReady } from "./helpers";

test.describe("smoke", () => {
  test("page loads, composer becomes ready, Clear is reachable", async ({
    page
  }) => {
    await gotoFresh(page);
    await waitForChatReady(page);

    // Composer should accept input (and round-trip back the value).
    const composer = parentComposer(page);
    await composer.fill("hello");
    await expect(composer).toHaveValue("hello");
    await composer.fill("");

    // Clear button is hidden behind a `disabled={messages.length === 0}`
    // check, so on a fresh page it's disabled. Just assert it exists.
    await expect(page.getByRole("button", { name: "Clear" })).toBeVisible();
  });
});
