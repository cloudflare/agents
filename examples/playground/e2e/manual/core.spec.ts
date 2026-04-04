import { expect, test } from "@playwright/test";
import {
  clearLogs,
  expectCounterValue,
  expectEventLogToContain,
  gotoDemo,
  waitForConnected
} from "../helpers";

test.describe("Playground core demos", () => {
  test("state management supports server/client updates and item mutations", async ({
    page
  }) => {
    await gotoDemo(page, "/core/state");
    await waitForConnected(page);

    // Reset to clean state in case a previous run left stale data.
    await page.getByRole("button", { name: "Reset" }).click();
    await clearLogs(page);

    await expectCounterValue(page, 0);

    await page.getByRole("button", { name: "+1" }).click();
    await expectCounterValue(page, 1);
    await expectEventLogToContain(page, "increment()");

    await page.getByRole("button", { name: "-1" }).click();
    await expectCounterValue(page, 0);
    await expectEventLogToContain(page, "decrement()");

    await page.getByLabel("Custom counter value").fill("42");
    await page.getByRole("button", { name: "Set (Server)" }).click();
    await expectCounterValue(page, 42);
    await expectEventLogToContain(page, "setCounter(42)");

    await page.getByLabel("Custom counter value").fill("100");
    await page.getByRole("button", { name: "Set (Client)" }).click();
    await expectCounterValue(page, 100);
    await expectEventLogToContain(page, "setState");

    await page.getByLabel("New item").fill("Test Item");
    await page.getByRole("button", { name: "Add" }).click();
    const itemRow = page.locator("li").filter({ hasText: "Test Item" });
    await expect(itemRow).toHaveCount(1);

    await itemRow.getByRole("button", { name: "Remove" }).click();
    await expect(
      page.locator("li").filter({ hasText: "Test Item" })
    ).toHaveCount(0);

    await page.getByRole("button", { name: "Reset" }).click();
    await expectCounterValue(page, 0);
  });

  test("state management syncs across tabs", async ({ browser }) => {
    const context = await browser.newContext();
    const pageA = await context.newPage();
    const pageB = await context.newPage();

    try {
      await gotoDemo(pageA, "/core/state");
      await gotoDemo(pageB, "/core/state");
      await waitForConnected(pageA);
      await waitForConnected(pageB);

      await pageA.getByRole("button", { name: "Reset" }).click();
      await expectCounterValue(pageA, 0);
      await expectCounterValue(pageB, 0);

      await pageA.getByRole("button", { name: "+1" }).click();
      await expectCounterValue(pageA, 1);
      await expectCounterValue(pageB, 1);
    } finally {
      await context.close();
    }
  });

  test("callable methods handle success, introspection, and errors", async ({
    page
  }) => {
    await gotoDemo(page, "/core/callable");
    await waitForConnected(page);
    await clearLogs(page);

    await page.getByRole("button", { name: "add(5, 3)" }).click();
    await expect(page.getByText(/^8$/).first()).toBeVisible();
    await expectEventLogToContain(page, '"method":"add"');

    await page.getByRole("button", { name: "multiply(5, 3)" }).click();
    await expect(page.getByText(/^15$/).first()).toBeVisible();

    await page.getByLabel("Echo message").fill("Hello World");
    await page.getByRole("button", { name: "Echo" }).click();
    await expect(page.getByText("Echo: Hello World").first()).toBeVisible();

    await page.getByLabel("Delay in milliseconds").fill("2000");
    await page.getByRole("button", { name: "slowOperation(2000)" }).click();
    await expect(page.getByText("Completed after 2000ms").first()).toBeVisible({
      timeout: 10_000
    });

    await page.getByRole("button", { name: "getTimestamp()" }).click();
    await expect(
      page.getByText(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/).first()
    ).toBeVisible();

    await page.getByRole("button", { name: "listMethods()" }).click();
    await expect(page.getByText("Available Methods")).toBeVisible();
    await expect(page.getByText("throwError").first()).toBeVisible();

    await page.getByLabel("Error message").fill("Something broke");
    await page.getByRole("button", { name: "Throw Error" }).click();
    await expect(page.getByText("Error: Something broke")).toBeVisible();
    await expectEventLogToContain(page, "Something broke");
  });

  test("streaming rpc shows chunks, completion, and stream errors", async ({
    page
  }) => {
    await gotoDemo(page, "/core/streaming");
    await waitForConnected(page);
    await clearLogs(page);

    await page.getByLabel("Countdown start").fill("5");
    await page.getByRole("button", { name: "Countdown from 5" }).click();
    await expect(
      page.getByRole("button", { name: "Streaming..." }).first()
    ).toBeDisabled();
    await expect(page.getByText('"label":"5..."').first()).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Countdown from 5" })
    ).toBeEnabled({ timeout: 10_000 });

    await page.getByLabel("Number count").fill("4");
    await page.getByRole("button", { name: "Stream 4 numbers" }).click();
    await expect(page.getByText('"number":1').first()).toBeVisible();
    await expect(page.getByText('"number":4').first()).toBeVisible();
    await expect(page.getByText('"total": 4').first()).toBeVisible();

    await page.getByLabel("Error after N items").fill("2");
    await page.getByRole("button", { name: "Error after 2 chunks" }).click();
    await expect(page.getByText('"number":2').first()).toBeVisible();
    await expectEventLogToContain(page, "Intentional error for testing");
    await expectEventLogToContain(page, "stream_done");
  });
});
