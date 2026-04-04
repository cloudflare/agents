import { expect, test } from "@playwright/test";
import {
  clearLogs,
  expectEventLogToContain,
  gotoDemo,
  waitForConnected
} from "../helpers";

test.describe("Scheduling, email local, codemode smoke, and error scenarios", () => {
  test("schedule demo supports one-time, recurring, cancel, refresh, and auto-scroll", async ({
    page
  }) => {
    await gotoDemo(page, "/core/schedule");
    await waitForConnected(page);
    await clearLogs(page);

    await page.getByLabel("Delay in seconds").fill("2");
    await page.getByLabel("Task message").fill("hello schedule");
    await page.getByRole("button", { name: "Schedule Task" }).click();
    await expect(page.getByText(/Active Schedules \(1\)/)).toBeVisible();
    await expectEventLogToContain(page, "scheduled");
    await expectEventLogToContain(page, "schedule_executed");

    await page.getByLabel("Interval in seconds").fill("5");
    await page.getByLabel("Recurring task label").fill("ping");
    await page.getByRole("button", { name: "Schedule Recurring" }).click();
    await expect(page.getByText(/Active Schedules \(1\)/)).toBeVisible();
    await page.getByRole("button", { name: "Refresh" }).click();
    await expect(page.getByText("onRecurringTask").first()).toBeVisible();

    const logEntryCount = await page.getByTestId("event-log-entry").count();
    expect(logEntryCount).toBeGreaterThan(3);
    await expect(
      page.getByTestId("event-log-entries").evaluate((node) => {
        const el = node as HTMLDivElement;
        return el.scrollTop + el.clientHeight >= el.scrollHeight - 4;
      })
    ).resolves.toBe(true);

    await page.getByRole("button", { name: "Cancel" }).click();
    await expect(page.getByText("No active schedules")).toBeVisible();
  });

  test("event log shows info, outgoing, incoming, and error entry types", async ({
    page
  }) => {
    await gotoDemo(page, "/core/callable");
    await waitForConnected(page);

    const infoEntry = page.getByTestId("event-log-entry").first();
    await expect(infoEntry).toHaveAttribute("data-direction", "info");

    await page.getByRole("button", { name: "add(5, 3)" }).click();
    await page.getByLabel("Error message").fill("Log type check");
    await page.getByRole("button", { name: "Throw Error" }).click();

    await expect(
      page
        .locator('[data-testid="event-log-entry"][data-direction="out"]')
        .first()
    ).toBeVisible();
    await expect(
      page
        .locator('[data-testid="event-log-entry"][data-direction="in"]')
        .first()
    ).toBeVisible();
    await expect(
      page
        .locator('[data-testid="event-log-entry"][data-direction="error"]')
        .first()
    ).toContainText("Log type check");
  });

  test("codemode page can send a message, stream a response, expand a tool card, and clear history", async ({
    page
  }) => {
    await gotoDemo(page, "/ai/codemode?e2e=1");
    await expect(page.getByText("Try Codemode")).toBeVisible();

    await page
      .getByPlaceholder(/Ask me to calculate/i)
      .fill("What is 17 + 25?");
    await page.getByRole("button", { name: /Send message/i }).click();

    await expect(page.getByText("What is 17 + 25?")).toBeVisible();
    await expect(page.getByText(/Thinking through that request/)).toBeVisible();
    await expect(page.getByText(/The result is/)).toBeVisible({
      timeout: 10_000
    });

    await expect(page.getByTestId("codemode-tool-card")).toBeVisible();
    await page.getByTestId("codemode-tool-toggle").click();
    await expect(page.getByText("const result = 17 + 25;")).toBeVisible();
    await expect(page.getByText("42").first()).toBeVisible();

    await page.getByRole("button", { name: /Clear history/i }).click();
    await expect(page.getByText("Try Codemode")).toBeVisible();
  });

  test("basic invalid-input scenarios are handled and connection failure stays connecting", async ({
    browser
  }) => {
    const page = await browser.newPage();
    await gotoDemo(page, "/core/state");
    await waitForConnected(page);

    await page.getByRole("button", { name: "Add" }).click();
    await expect(page.getByText("No items")).toBeVisible();

    await page.getByLabel("Custom counter value").evaluate((node) => {
      const input = node as HTMLInputElement;
      input.value = "abc";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await page.getByRole("button", { name: "Set (Server)" }).click();
    await expect(page.getByRole("heading", { name: /Counter:/ })).toBeVisible();
    await page.close();

    const failingPage = await browser.newPage();
    await failingPage.addInitScript(() => {
      class FakeWebSocket {
        static CONNECTING = 0;
        static OPEN = 1;
        static CLOSING = 2;
        static CLOSED = 3;
        readyState = 0;
        onopen: ((event: Event) => void) | null = null;
        onclose: ((event: Event) => void) | null = null;
        onerror: ((event: Event) => void) | null = null;
        onmessage: ((event: MessageEvent) => void) | null = null;
        constructor() {}
        close() {
          this.readyState = 3;
          this.onclose?.(new Event("close"));
        }
        send() {}
        addEventListener() {}
        removeEventListener() {}
      }
      // @ts-expect-error test override
      window.WebSocket = FakeWebSocket;
    });
    await gotoDemo(failingPage, "/core/state");
    await expect(failingPage.getByTestId("connection-status")).toHaveAttribute(
      "data-status",
      "connecting"
    );
    await failingPage.close();
  });
});
