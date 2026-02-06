import type { Page } from "@playwright/test";
import { expect } from "@playwright/test";

/**
 * Wait for the chat interface to be ready (input visible and agent idle)
 */
export async function waitForChatReady(page: Page, timeout = 30000) {
  // First wait for the input to be visible
  await expect(page.getByTestId("chat-input")).toBeVisible({ timeout });

  // Wait for agent to be idle (input is only enabled when idle)
  await expect(page.getByTestId("status-badge")).toHaveAttribute(
    "data-status",
    "idle",
    { timeout }
  );
  await expect(page.getByTestId("chat-input")).toBeEnabled({ timeout });
}

/**
 * Send a chat message and wait for it to appear
 */
export async function sendMessage(page: Page, message: string) {
  const input = page.getByTestId("chat-input");

  // Ensure input is ready
  await expect(input).toBeVisible({ timeout: 10000 });
  await expect(input).toBeEnabled({ timeout: 10000 });

  await input.fill(message);
  await input.press("Enter");

  // Wait for user message to appear in chat
  await expect(page.getByTestId("message-user").last()).toContainText(message, {
    timeout: 15000
  });
}

/**
 * Wait for assistant response to start streaming
 */
export async function waitForAssistantResponse(page: Page, timeout = 30000) {
  await expect(page.getByTestId("message-assistant").last()).toBeVisible({
    timeout
  });
}

/**
 * Wait for the agent to return to idle state
 */
export async function waitForIdle(page: Page, timeout = 60000) {
  await expect(page.getByTestId("status-badge")).toHaveAttribute(
    "data-status",
    "idle",
    { timeout }
  );
}

/**
 * Get the content of the last assistant message
 */
export async function getLastAssistantMessage(page: Page): Promise<string> {
  const messages = page.getByTestId("message-assistant");
  const count = await messages.count();
  if (count === 0) return "";
  return messages.nth(count - 1).innerText();
}

/**
 * Check if a tool call is visible in the chat
 */
export async function hasToolCall(
  page: Page,
  toolName: string
): Promise<boolean> {
  const toolCalls = page.locator(`[data-tool="${toolName}"]`);
  return (await toolCalls.count()) > 0;
}

/**
 * Clear chat history via API
 */
export async function clearChatHistory(page: Page) {
  await page.request.post("/agents/think/dev-session/chat/clear");
}

/**
 * Get current status
 */
export async function getStatus(page: Page): Promise<string> {
  return (
    (await page.getByTestId("status-badge").getAttribute("data-status")) ||
    "unknown"
  );
}

/**
 * Wait for status to be a specific value
 */
export async function waitForStatus(
  page: Page,
  status: string,
  timeout = 30000
) {
  await expect(page.getByTestId("status-badge")).toHaveAttribute(
    "data-status",
    status,
    { timeout }
  );
}

/**
 * Click the stop button
 */
export async function clickStop(page: Page) {
  await page.getByTestId("stop-button").click();
}

/**
 * Click the retry button
 */
export async function clickRetry(page: Page) {
  await page.getByTestId("retry-button").click();
}

/**
 * Check if stop button is visible
 */
export async function isStopButtonVisible(page: Page): Promise<boolean> {
  return page.getByTestId("stop-button").isVisible();
}

/**
 * Check if retry button is visible
 */
export async function isRetryButtonVisible(page: Page): Promise<boolean> {
  return page.getByTestId("retry-button").isVisible();
}

/**
 * Take a screenshot with a descriptive name
 */
export async function screenshot(page: Page, name: string) {
  await page.screenshot({
    path: `browser-tests/screenshots/${name}.png`,
    fullPage: true
  });
}
