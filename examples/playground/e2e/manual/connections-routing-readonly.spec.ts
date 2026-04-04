import { expect, test } from "@playwright/test";
import {
  expectEventLogToContain,
  gotoDemo,
  waitForConnected
} from "../helpers";

test.describe("Connections, routing, and readonly demos", () => {
  test("connections demo supports connection counts and broadcasts across tabs", async ({
    browser
  }) => {
    const context = await browser.newContext();
    const pageA = await context.newPage();
    const pageB = await context.newPage();

    try {
      await gotoDemo(pageA, "/core/connections");
      await gotoDemo(pageB, "/core/connections");
      await waitForConnected(pageA);
      await waitForConnected(pageB);

      await expect(pageA.getByTestId("connections-count")).toContainText("2");
      await expect(pageB.getByTestId("connections-count")).toContainText("2");
      await expectEventLogToContain(pageA, "connection_count");

      await pageA.getByLabel("Broadcast message").fill("Hello tabs");
      await pageA.getByRole("button", { name: "Broadcast" }).click();
      await expect(
        pageA.getByTestId("broadcast-message").filter({ hasText: "Hello tabs" })
      ).toHaveCount(1);
      await expect(
        pageB.getByTestId("broadcast-message").filter({ hasText: "Hello tabs" })
      ).toHaveCount(1);

      await pageB.close();
      await expect(pageA.getByTestId("connections-count")).toContainText("1");
    } finally {
      await context.close();
    }
  });

  test("routing strategies switch instances and persist user id", async ({
    page
  }) => {
    await gotoDemo(page, "/core/routing");
    await waitForConnected(page);
    await page.getByLabel(/User ID/).fill("user-alpha");
    await expect(page.getByTestId("routing-agent-instance")).toContainText(
      "routing-user-alpha"
    );

    await page.getByText(/All users share a single agent instance/).click();
    await expect(page.getByTestId("routing-agent-instance")).toContainText(
      "routing-shared"
    );

    await expect(
      page.getByText(/Session ID \(auto-generated per tab\)/)
    ).toBeVisible();

    await page.getByText(/Each user ID gets their own agent instance/).click();
    await page.reload();
    await expect(page.getByLabel(/User ID/)).toHaveValue("user-alpha");
  });

  test("readonly demo blocks viewer writes and allows toggling lock", async ({
    page
  }) => {
    await gotoDemo(page, "/core/readonly");
    await expect(page.getByTestId("readonly-panel-edit")).toBeVisible();
    await expect(page.getByTestId("readonly-panel-view")).toBeVisible();

    const editor = page.getByTestId("readonly-panel-edit");
    const viewer = page.getByTestId("readonly-panel-view");

    await editor.getByRole("button", { name: /^\+1$/ }).click();
    await expect(editor.getByTestId("readonly-counter-edit")).toContainText(
      "1"
    );
    await expect(viewer.getByTestId("readonly-counter-view")).toContainText(
      "1"
    );
    await expect(viewer).toContainText("Last updated by: server");

    await viewer.getByRole("button", { name: /^\+1$/ }).click();
    await expect(viewer).toContainText("readonly");

    await viewer.getByRole("button", { name: "+10" }).click();
    await expect(viewer).toContainText("readonly");

    await viewer.getByRole("button", { name: "Check Permissions" }).click();
    await expect(viewer).toContainText("canEdit = false");

    await viewer.getByTestId("readonly-toggle").click();
    await expect(viewer.getByTestId("readonly-badge-view")).toContainText(
      "read-write"
    );
    await viewer.getByRole("button", { name: /^\+1$/ }).click();
    await expect(viewer).toContainText("2");
  });
});
