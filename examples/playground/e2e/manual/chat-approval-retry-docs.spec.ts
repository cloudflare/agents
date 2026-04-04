import { expect, test } from "@playwright/test";
import {
  clearLogs,
  expectEventLogToContain,
  gotoDemo,
  waitForConnected
} from "../helpers";

const docsPages = [
  { route: "/multi-agent/workers", title: "Workers Pattern" },
  { route: "/multi-agent/pipeline", title: "Pipeline Pattern" },
  { route: "/ai/chat", title: "AI Chat" },
  { route: "/ai/tools", title: "Tools" },
  { route: "/mcp/server", title: "MCP Server" },
  { route: "/mcp/client", title: "MCP Client" },
  { route: "/mcp/oauth", title: "MCP OAuth" }
] as const;

test.describe("Chat rooms, approvals, retries, and docs pages", () => {
  test("chat rooms support create, join, send, multi-user, leave, and persistence", async ({
    browser
  }) => {
    const context = await browser.newContext();
    const pageA = await context.newPage();
    const pageB = await context.newPage();

    try {
      await gotoDemo(pageA, "/multi-agent/rooms");
      await gotoDemo(pageB, "/multi-agent/rooms");
      await waitForConnected(pageA);
      await waitForConnected(pageB);

      await pageA.getByLabel("Your Username").fill("alice");
      await pageB.getByLabel("Your Username").fill("bob");

      await pageA.getByLabel("Room name").fill("General");
      await pageA.getByRole("button", { name: "Create" }).click();
      await expect(
        pageA.getByTestId("chat-room-button").filter({ hasText: "General" })
      ).toHaveCount(1);

      await pageA
        .getByTestId("chat-room-button")
        .filter({ hasText: "General" })
        .click();
      await pageB
        .getByTestId("chat-room-button")
        .filter({ hasText: "General" })
        .click();

      await expect(
        pageA.getByText("General", { exact: true }).first()
      ).toBeVisible();
      await expect(
        pageB.getByText("General", { exact: true }).first()
      ).toBeVisible();
      await expect(pageA.getByText(/1 members|2 members/)).toBeVisible();

      await pageA.getByLabel("Chat message").fill("Hello from alice");
      await pageA.getByRole("button", { name: "Send" }).click();
      await expect(
        pageB
          .getByTestId("chat-message")
          .filter({ hasText: "Hello from alice" })
          .first()
      ).toBeVisible();
      await expect(pageA.getByText(/1 members|2 members/)).toBeVisible();
      await expect(pageB.getByText(/1 members|2 members/)).toBeVisible();

      await pageB.getByRole("button", { name: "Leave" }).click();
      await expect(
        pageB.getByText("Select a room to start chatting")
      ).toBeVisible();

      await pageA.reload();
      await expect(
        pageA.getByTestId("chat-room-button").filter({ hasText: "General" })
      ).toHaveCount(1);
    } finally {
      await context.close();
    }
  });

  test("approval workflow supports submit, presets, approve, reject, multiple pending, and clear", async ({
    page
  }) => {
    await gotoDemo(page, "/workflow/approval");
    await waitForConnected(page);
    await clearLogs(page);

    await page.getByLabel("Title").fill("Deploy v2.0 to Production");
    await page.getByLabel("Description").fill("Ship the release");
    await page.getByRole("button", { name: "Submit Request" }).click();
    await expect(page.getByText("Pending Approval (1)")).toBeVisible();
    await expectEventLogToContain(page, "approval_requested");

    await page.getByRole("button", { name: "Approve" }).click();
    await expect(page.getByText("History (1)")).toBeVisible();
    await expectEventLogToContain(page, "approval_approved");

    await page
      .getByRole("button", { name: /Access Request - Admin Panel/ })
      .click();
    await page.getByRole("button", { name: "Submit Request" }).click();
    await page.getByRole("button", { name: "Reject" }).click();
    await page.getByLabel("Rejection reason").fill("Needs review");
    await page.getByRole("button", { name: "Confirm Reject" }).click();
    await expectEventLogToContain(page, "approval_error");
    await expect(page.getByText("Needs review").first()).toBeVisible();

    for (const presetTitle of [
      "Deploy to Production",
      "Expense Report - $450"
    ]) {
      await page.getByRole("button", { name: presetTitle }).click();
      await expect(
        page.getByRole("button", { name: "Submit Request" })
      ).toBeEnabled();
      await page.getByRole("button", { name: "Submit Request" }).click();
    }
    await expect(page.getByText(/Pending Approval \([12]\)/)).toBeVisible();

    await page
      .getByRole("button", { name: /^Clear$/ })
      .first()
      .click();
    await expectEventLogToContain(page, "cleared");
  });

  test("retry demo covers flaky, filtered, queued retries, and log clearing", async ({
    page
  }) => {
    await gotoDemo(page, "/core/retry");
    await waitForConnected(page);

    await page.getByLabel("Succeed on attempt number").fill("3");
    await page.getByRole("button", { name: "Run Flaky Operation" }).click();
    await expectEventLogToContain(page, "Attempt 1");
    await expectEventLogToContain(page, "Success on attempt 3");

    await page.getByLabel("Succeed on attempt number").fill("10");
    await page.getByRole("button", { name: "Run Flaky Operation" }).click();
    await expectEventLogToContain(page, "Transient failure on attempt 4");

    await page.getByLabel("Number of failures").fill("2");
    await page.getByRole("button", { name: "Run Filtered Retry" }).click();
    await expectEventLogToContain(page, "Success on attempt 3");

    await page.getByRole("checkbox").check();
    await page.getByRole("button", { name: "Run Filtered Retry" }).click();
    await expectEventLogToContain(page, "shouldRetry returned false");

    await page.getByLabel("Max retry attempts").fill("3");
    await page.getByRole("button", { name: "Queue Task" }).click();
    await expectEventLogToContain(page, "queued");
    await expectEventLogToContain(page, "Queue callback attempt 3");

    await page.getByRole("button", { name: /^Clear Logs$/ }).click();
    await expect(page.getByTestId("event-log-empty")).toBeVisible();
  });

  for (const docsPage of docsPages) {
    test(`docs page loads: ${docsPage.title}`, async ({ page }) => {
      await gotoDemo(page, docsPage.route);
      await expect(page.getByTestId("demo-title")).toHaveText(docsPage.title);
      await expect(page.getByTestId("demo-page")).toBeVisible();
    });
  }
});
