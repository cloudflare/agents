import { expect, type Page } from "@playwright/test";

export async function gotoDemo(page: Page, route: string) {
  await page.goto(route);
  await expect(page.getByTestId("demo-page")).toBeVisible();
}

export async function waitForConnected(page: Page) {
  await expect(page.getByTestId("connection-status")).toHaveAttribute(
    "data-status",
    "connected",
    { timeout: 20_000 }
  );
}

export async function expectEventLogToContain(page: Page, text: string) {
  await expect(page.getByTestId("event-log")).toContainText(text, {
    timeout: 20_000
  });
}

export async function expectCounterValue(page: Page, value: number) {
  await expect(
    page.getByRole("heading", { name: `Counter: ${value}` })
  ).toBeVisible();
}

export async function clearLogs(page: Page) {
  await page.getByLabel("Clear logs").click();
  await expect(page.getByTestId("event-log-empty")).toBeVisible();
}
