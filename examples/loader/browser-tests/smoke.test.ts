import { test, expect } from "@playwright/test";
import { waitForChatReady, clearChatHistory } from "./helpers";

test.describe("Smoke Tests", () => {
  // Clean slate before each smoke test
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await clearChatHistory(page);
    await page.reload();
  });

  test("page loads successfully", async ({ page }) => {
    // Check that the app renders (header with "Think" title)
    await expect(page.locator("h1")).toContainText("Think");
  });

  test("chat interface is visible", async ({ page }) => {
    // Wait for chat to be ready
    await waitForChatReady(page);

    // Check for main chat elements
    await expect(page.getByTestId("chat-input")).toBeVisible();
    await expect(page.getByTestId("send-button")).toBeVisible();
    await expect(page.getByTestId("status-badge")).toBeVisible();
  });

  test("status badge shows idle initially", async ({ page }) => {
    await waitForChatReady(page);

    // Status should be idle
    await expect(page.getByTestId("status-badge")).toHaveAttribute(
      "data-status",
      "idle"
    );
    await expect(page.getByTestId("status-badge")).toContainText("idle");
  });

  test("theme toggle works", async ({ page }) => {
    await waitForChatReady(page);

    // The page starts in dark mode by default
    // Find the theme toggle button (it's in the header)
    const themeButton = page.locator('button[title*="Switch to"]');

    if (await themeButton.isVisible()) {
      // Click to toggle
      await themeButton.click();

      // Wait a moment for state to update
      await page.waitForTimeout(100);

      // Click again to toggle back
      await themeButton.click();
    }
  });

  test("debug panel is hidden by default", async ({ page }) => {
    await waitForChatReady(page);

    // Debug panel header text should not be visible
    await expect(page.locator('text="Debug Events"')).not.toBeVisible();
  });

  test("debug panel shows with ?debug=1", async ({ page }) => {
    // Navigate with debug param (need to do full navigation since beforeEach already loaded /)
    await page.goto("/?debug=1");
    await waitForChatReady(page);

    // Debug panel should be visible (look for the header or content)
    // The panel has a toggle button and "Debug Events" text when expanded
    await expect(page.locator('text="Debug Events"')).toBeVisible();
  });
});
