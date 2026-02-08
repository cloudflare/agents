import { test, expect } from "@playwright/test";
import {
  waitForChatReady,
  sendMessage,
  waitForAssistantResponse,
  waitForIdle,
  clearChatHistory
} from "./helpers";

/**
 * WebSocket Streaming Protocol Tests
 *
 * Tests for Phase 5.3: multi-tab sync, history on connect,
 * reconnection with state replay, and message broadcasting.
 */

test.describe("WebSocket Streaming Protocol", () => {
  test.describe("History on Connect", () => {
    test("should restore chat history after page reload", async ({ page }) => {
      test.skip(!process.env.OPENAI_API_KEY, "Requires OPENAI_API_KEY");

      // Start with clean state
      await page.goto("/");
      await clearChatHistory(page);
      await page.reload();
      await waitForChatReady(page, 60000);

      // Send a message and wait for response
      await sendMessage(page, "Say exactly: HISTORY_TEST_OK");
      await waitForAssistantResponse(page, 30000);
      await waitForIdle(page, 60000);

      // Verify we have both user and assistant messages
      const userMessages = page.getByTestId("message-user");
      const assistantMessages = page.getByTestId("message-assistant");
      await expect(userMessages).toHaveCount(1);
      const assistantCount = await assistantMessages.count();
      expect(assistantCount).toBeGreaterThanOrEqual(1);

      // Reload the page
      await page.reload();
      await waitForChatReady(page, 60000);

      // History should be restored via WebSocket "history" message
      // Verify user message is still there
      await expect(page.getByTestId("message-user")).toHaveCount(1);
      await expect(page.getByTestId("message-user")).toContainText(
        "HISTORY_TEST_OK"
      );

      // Verify assistant message is still there
      const restoredAssistant = page.getByTestId("message-assistant");
      const restoredCount = await restoredAssistant.count();
      expect(restoredCount).toBeGreaterThanOrEqual(1);
    });

    test("should start with empty history after clear", async ({ page }) => {
      await page.goto("/");
      await clearChatHistory(page);
      await page.reload();
      await waitForChatReady(page, 60000);

      // Should have no messages
      const userMessages = page.getByTestId("message-user");
      const assistantMessages = page.getByTestId("message-assistant");
      expect(await userMessages.count()).toBe(0);
      expect(await assistantMessages.count()).toBe(0);
    });
  });

  test.describe("Multi-Tab Sync", () => {
    test("second tab should see messages sent from first tab", async ({
      browser
    }) => {
      test.skip(!process.env.OPENAI_API_KEY, "Requires OPENAI_API_KEY");

      // Create two independent browser contexts (simulates two tabs)
      const context1 = await browser.newContext();
      const context2 = await browser.newContext();
      const page1 = await context1.newPage();
      const page2 = await context2.newPage();

      try {
        // Clear history and set up both pages
        await page1.goto("/");
        await clearChatHistory(page1);

        // Navigate both tabs to the chat (same room: dev-session)
        await page1.reload();
        await page2.goto("/");
        await waitForChatReady(page1, 60000);
        await waitForChatReady(page2, 60000);

        // Send a message from page1
        await sendMessage(page1, "Say exactly: MULTI_TAB_SYNC");
        await waitForAssistantResponse(page1, 30000);
        await waitForIdle(page1, 60000);

        // Page2 should see the user message (broadcast via user_message event)
        // Give it a moment to receive the WebSocket broadcast
        await page2.waitForTimeout(2000);

        // Page2 should have received the user_message broadcast
        // and also the streaming assistant response
        const page2UserMsgs = page2.getByTestId("message-user");
        const page2AssistantMsgs = page2.getByTestId("message-assistant");

        // Page2 should see the user message
        const userCount = await page2UserMsgs.count();
        expect(userCount).toBeGreaterThanOrEqual(1);

        // Page2 should also see the assistant response (broadcast via text_delta)
        const assistantCount = await page2AssistantMsgs.count();
        expect(assistantCount).toBeGreaterThanOrEqual(1);
      } finally {
        await context1.close();
        await context2.close();
      }
    });

    test("second tab should receive history on connect", async ({
      browser
    }) => {
      test.skip(!process.env.OPENAI_API_KEY, "Requires OPENAI_API_KEY");

      const context1 = await browser.newContext();
      const context2 = await browser.newContext();
      const page1 = await context1.newPage();
      const page2 = await context2.newPage();

      try {
        // Set up page1 with a conversation
        await page1.goto("/");
        await clearChatHistory(page1);
        await page1.reload();
        await waitForChatReady(page1, 60000);

        // Send a message and wait for response
        await sendMessage(page1, "Say exactly: TAB_HISTORY_CHECK");
        await waitForAssistantResponse(page1, 30000);
        await waitForIdle(page1, 60000);

        // Now open page2 - it should receive history on connect
        await page2.goto("/");
        await waitForChatReady(page2, 60000);

        // Page2 should have the history
        await expect(page2.getByTestId("message-user")).toContainText(
          "TAB_HISTORY_CHECK",
          { timeout: 10000 }
        );

        const assistantMsgs = page2.getByTestId("message-assistant");
        const count = await assistantMsgs.count();
        expect(count).toBeGreaterThanOrEqual(1);
      } finally {
        await context1.close();
        await context2.close();
      }
    });
  });

  test.describe("Reconnection", () => {
    test("should restore status to idle after reconnect when agent is done", async ({
      page
    }) => {
      test.skip(!process.env.OPENAI_API_KEY, "Requires OPENAI_API_KEY");

      await page.goto("/");
      await clearChatHistory(page);
      await page.reload();
      await waitForChatReady(page, 60000);

      // Send message and wait for completion
      await sendMessage(page, "Say exactly: RECONNECT_TEST");
      await waitForIdle(page, 60000);

      // Reload (simulates reconnection)
      await page.reload();
      await waitForChatReady(page, 60000);

      // Status should be idle (from sync message)
      const status = await page
        .getByTestId("status-badge")
        .getAttribute("data-status");
      expect(status).toBe("idle");

      // History should be present
      await expect(page.getByTestId("message-user")).toContainText(
        "RECONNECT_TEST"
      );
    });

    test("should restore tool calls in history after reconnect", async ({
      page
    }) => {
      test.skip(!process.env.OPENAI_API_KEY, "Requires OPENAI_API_KEY");

      await page.goto("/");
      await clearChatHistory(page);
      await page.reload();
      await waitForChatReady(page, 60000);

      // Send a message that triggers tool use
      await sendMessage(
        page,
        "List all files in the project using the listFiles tool"
      );
      await waitForIdle(page, 60000);

      // There should be a tool call visible
      // Tool calls are rendered with data-tool attribute or inside the message
      const assistantMsg = page.getByTestId("message-assistant").last();
      await expect(assistantMsg).toBeVisible();

      // Reload
      await page.reload();
      await waitForChatReady(page, 60000);

      // After reload, assistant message should still be visible with tool calls
      // (history now includes toolCalls and reasoning)
      const restoredAssistant = page.getByTestId("message-assistant").last();
      await expect(restoredAssistant).toBeVisible({ timeout: 10000 });

      // The tool call indicators should be present in the restored message
      // They're rendered as clickable buttons with the tool name
      const toolCallElements = restoredAssistant.locator(
        '[class*="font-mono"]'
      );
      const toolCallCount = await toolCallElements.count();
      expect(toolCallCount).toBeGreaterThanOrEqual(1);
    });
  });
});
