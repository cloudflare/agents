import { test, expect } from "@playwright/test";
import {
  waitForChatReady,
  sendMessage,
  waitForAssistantResponse,
  waitForIdle,
  clearChatHistory,
  getLastAssistantMessage,
  clickStop,
  clickRetry
} from "./helpers";

test.describe("Chat Flow", () => {
  test.beforeEach(async ({ page }) => {
    // Navigate to app
    await page.goto("/");

    // Clear chat history via API before each test
    await clearChatHistory(page);

    // Reload to get fresh state
    await page.reload();

    // Wait for app to be ready and idle
    await waitForChatReady(page, 60000);
  });

  test("can send a message", async ({ page }) => {
    const testMessage = "Hello, this is a test message";

    // Send message
    await sendMessage(page, testMessage);

    // Verify message appears in chat
    await expect(page.getByTestId("message-user")).toContainText(testMessage);
  });

  test("receives streaming response", async ({ page }) => {
    // Skip if no API key configured
    test.skip(!process.env.OPENAI_API_KEY, "Requires OPENAI_API_KEY");

    // Send a simple message
    await sendMessage(page, "Say hello in exactly 3 words");

    // Wait for assistant response to appear
    await waitForAssistantResponse(page, 30000);

    // Wait for completion
    await waitForIdle(page, 60000);

    // The response should contain some text
    const response = await getLastAssistantMessage(page);
    expect(response.length).toBeGreaterThan(0);
  });

  test("status changes during processing", async ({ page }) => {
    test.skip(!process.env.OPENAI_API_KEY, "Requires OPENAI_API_KEY");

    // Check initial idle state
    await expect(page.getByTestId("status-badge")).toHaveAttribute(
      "data-status",
      "idle"
    );

    // Send message
    await sendMessage(page, "What is 2+2? Reply with just the number.");

    // Wait for assistant response (ensures LLM call succeeded)
    await waitForAssistantResponse(page, 30000);

    // Eventually we should get back to idle with a response
    await waitForIdle(page, 60000);

    // Verify we got a response
    const response = await getLastAssistantMessage(page);
    expect(response.length).toBeGreaterThan(0);
  });

  test("stop button appears during generation", async ({ page }) => {
    test.skip(!process.env.OPENAI_API_KEY, "Requires OPENAI_API_KEY");

    // Send a message that will take a while
    await sendMessage(
      page,
      "Write a very long detailed story about a dragon who learns to code. Include many paragraphs."
    );

    // Wait for some content to start streaming
    await expect(page.getByTestId("message-assistant")).toBeVisible({
      timeout: 10000
    });

    // Stop button should be visible
    await expect(page.getByTestId("stop-button")).toBeVisible();

    // Click stop
    await clickStop(page);

    // Should return to idle
    await waitForIdle(page, 30000);

    // Verify we ended up with some content (partial is fine)
    const response = await getLastAssistantMessage(page);
    // Response could be partial or have the stopped marker
    expect(response.length).toBeGreaterThan(0);
  });

  test("retry button appears after response", async ({ page }) => {
    test.skip(!process.env.OPENAI_API_KEY, "Requires OPENAI_API_KEY");

    // Send initial message
    await sendMessage(page, "Say the word APPLE");
    await waitForAssistantResponse(page);
    await waitForIdle(page, 60000);

    // Retry button should be visible when idle and there are messages
    await expect(page.getByTestId("retry-button")).toBeVisible();

    // Click retry
    await clickRetry(page);

    // Should transition away from idle (thinking/executing)
    // Then back to idle with a new response
    await waitForIdle(page, 60000);

    // Verify we still have an assistant message
    await expect(page.getByTestId("message-assistant")).toBeVisible();
  });
});

test.describe("Chat History", () => {
  test("persists messages across page reload", async ({ page }) => {
    test.skip(!process.env.OPENAI_API_KEY, "Requires OPENAI_API_KEY");

    await page.goto("/");
    await clearChatHistory(page);
    await page.reload();
    await waitForChatReady(page);

    // Send a unique message
    const uniqueMessage = `Test message ${Date.now()}`;
    await sendMessage(page, uniqueMessage);
    await waitForAssistantResponse(page);
    await waitForIdle(page, 60000);

    // Reload page
    await page.reload();
    await waitForChatReady(page);

    // Message should still be visible
    await expect(page.getByTestId("message-user")).toContainText(uniqueMessage);
  });

  test("clear history removes all messages", async ({ page }) => {
    await page.goto("/");
    await waitForChatReady(page);

    // Clear via API
    await clearChatHistory(page);

    // Reload
    await page.reload();
    await waitForChatReady(page);

    // Should have no messages
    const userMessages = await page.getByTestId("message-user").count();
    expect(userMessages).toBe(0);
  });
});

test.describe("UI Elements", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await clearChatHistory(page);
    await page.reload();
    await waitForChatReady(page);
  });

  test("send button is disabled when input is empty", async ({ page }) => {
    // Send button should be visible but effectively disabled (no input)
    const sendButton = page.getByTestId("send-button");
    await expect(sendButton).toBeVisible();

    // The button has disabled attribute when input is empty
    await expect(sendButton).toBeDisabled();
  });

  test("input is disabled while agent is thinking", async ({ page }) => {
    test.skip(!process.env.OPENAI_API_KEY, "Requires OPENAI_API_KEY");

    await sendMessage(page, "Hello");

    // Input should be disabled while processing
    await expect(page.getByTestId("chat-input")).toBeDisabled();

    // Wait for completion
    await waitForIdle(page, 60000);

    // Input should be enabled again
    await expect(page.getByTestId("chat-input")).toBeEnabled();
  });

  test("clear button works", async ({ page }) => {
    test.skip(!process.env.OPENAI_API_KEY, "Requires OPENAI_API_KEY");

    // Send a message first
    await sendMessage(page, "Hello");
    await waitForAssistantResponse(page);
    await waitForIdle(page, 60000);

    // Click clear button
    await page.locator('button:has-text("Clear")').click();

    // Messages should be gone
    await expect(page.getByTestId("message-user")).toHaveCount(0);
    await expect(page.getByTestId("message-assistant")).toHaveCount(0);
  });
});
