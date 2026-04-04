import { expect, test, type Page } from "@playwright/test";
import {
  clearLogs,
  expectEventLogToContain,
  gotoDemo,
  waitForConnected
} from "../helpers";

async function setWorkflowStepCount(page: Page, value: string) {
  await page.locator("#step-count").evaluate((node, nextValue) => {
    const input = node as HTMLInputElement;
    input.value = nextValue;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }, value);
}

test.describe("Playground navigation and workflows", () => {
  test("theme toggle cycles, persists, and follows system preference", async ({
    page
  }) => {
    await page.emulateMedia({ colorScheme: "light" });
    await page.goto("/");
    await expect(page.getByText("Agents SDK Playground")).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute(
      "data-theme-preference",
      "system"
    );
    await expect(page.locator("html")).toHaveAttribute("data-mode", "light");

    const toggle = page.getByTestId("theme-toggle");
    await toggle.click();
    await expect(page.locator("html")).toHaveAttribute(
      "data-theme-preference",
      "light"
    );
    await expect(page.locator("html")).toHaveAttribute("data-mode", "light");

    await toggle.click();
    await expect(page.locator("html")).toHaveAttribute(
      "data-theme-preference",
      "dark"
    );
    await expect(page.locator("html")).toHaveAttribute("data-mode", "dark");

    await page.reload();
    await expect(page.locator("html")).toHaveAttribute(
      "data-theme-preference",
      "dark"
    );
    await expect(page.locator("html")).toHaveAttribute("data-mode", "dark");

    await toggle.click();
    await expect(page.locator("html")).toHaveAttribute(
      "data-theme-preference",
      "system"
    );

    await page.emulateMedia({ colorScheme: "dark" });
    await expect(page.locator("html")).toHaveAttribute("data-mode", "dark");
    await page.emulateMedia({ colorScheme: "light" });
    await expect(page.locator("html")).toHaveAttribute("data-mode", "light");
  });

  test("sidebar navigation opens demos, toggles categories, and external links open new tabs", async ({
    page
  }) => {
    await page.goto("/");
    await expect(page.getByText("Agents SDK Playground")).toBeVisible();

    const coreCategory = page.getByTestId("sidebar-category-core");
    await expect(coreCategory).toHaveAttribute("aria-expanded", "true");
    await coreCategory.click();
    await expect(coreCategory).toHaveAttribute("aria-expanded", "false");
    await coreCategory.click();
    await expect(coreCategory).toHaveAttribute("aria-expanded", "true");

    await page
      .getByTestId("sidebar-nav")
      .getByRole("link", { name: "State" })
      .click();
    await expect(page.getByTestId("demo-title")).toHaveText("State Management");

    const githubLink = page.getByRole("link", { name: "GitHub" });
    const docsLink = page.getByRole("link", { name: "Docs" });
    await expect(githubLink).toHaveAttribute("target", "_blank");
    await expect(docsLink).toHaveAttribute("target", "_blank");

    const [githubPage] = await Promise.all([
      page.context().waitForEvent("page"),
      githubLink.click()
    ]);
    await githubPage.waitForLoadState();
    await expect(githubPage).toHaveURL(/github\.com\/cloudflare\/agents/);
    await githubPage.close();

    const [docsPage] = await Promise.all([
      page.context().waitForEvent("page"),
      docsLink.click()
    ]);
    await docsPage.waitForLoadState();
    await expect(docsPage).toHaveURL(/developers\.cloudflare\.com\/agents/);
    await docsPage.close();
  });

  test("workflow basic demo starts multiple workflows, supports cancel, and can clear history", async ({
    page
  }) => {
    await gotoDemo(page, "/workflow/basic");
    await waitForConnected(page);
    await clearLogs(page);

    await page.getByLabel("Workflow Name").fill("Nightly Smoke");
    await setWorkflowStepCount(page, "2");
    await page.getByRole("button", { name: "Start Workflow" }).click();

    await expect(page.getByText("Active (1)")).toBeVisible();
    await expectEventLogToContain(page, "workflow_started");
    await expect(
      page.getByText("Nightly Smoke", { exact: true }).first()
    ).toBeVisible();

    await page.getByLabel("Workflow Name").fill("Second Workflow");
    await setWorkflowStepCount(page, "2");
    await page.getByRole("button", { name: "Start Workflow" }).click();
    await expect(page.getByText("Active (2)")).toBeVisible();
    await expect(
      page.getByText("Second Workflow", { exact: true }).first()
    ).toBeVisible();

    await page.getByTestId("workflow-cancel").first().click();
    await expectEventLogToContain(page, "workflow_terminated");
    await expect(
      page.locator('[data-workflow-status="terminated"]').first()
    ).toBeVisible({
      timeout: 20_000
    });

    await expect(page.getByText(/History \([12]\)/)).toBeVisible({
      timeout: 20_000
    });
    await expectEventLogToContain(page, "workflow_complete");

    await page
      .getByRole("heading", { name: /History \([12]\)/ })
      .locator("..")
      .getByRole("button", { name: "Clear" })
      .click();
    await expect(page.getByText("No completed workflows")).toBeVisible();
    await expectEventLogToContain(page, "cleared");
  });
});
