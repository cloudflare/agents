import { expect, test } from "@playwright/test";
import {
  clearLogs,
  expectEventLogToContain,
  gotoDemo,
  waitForConnected
} from "../helpers";

test.describe("Playground multi-agent and sql demos", () => {
  test("supervisor demo can create, update, remove, and clear child agents", async ({
    page
  }) => {
    await gotoDemo(page, "/multi-agent/supervisor");
    await waitForConnected(page);

    // Clear leftover children from previous runs to start from a known state.
    await page.getByRole("button", { name: "Clear All" }).click();
    await clearLogs(page);

    await expect(page.getByTestId("supervisor-total-children")).toBeVisible();
    await expect(page.getByTestId("supervisor-total-counter")).toBeVisible();

    await page.getByRole("button", { name: "+ Create Child" }).click();
    await page.getByRole("button", { name: "+ Create Child" }).click();
    await expect(page.getByText("Child Agents (2)")).toBeVisible();
    await expectEventLogToContain(page, "createChild");

    const childCards = page.getByTestId("supervisor-child-card");
    await expect(childCards).toHaveCount(2);

    await childCards.first().getByRole("button", { name: "+1" }).click();
    await expectEventLogToContain(page, "incrementChild");
    await expect(page.getByTestId("supervisor-total-counter")).toContainText(
      "1"
    );

    await page.getByRole("button", { name: "+1 to All" }).click();
    await expectEventLogToContain(page, "incrementAll()");
    await expect(page.getByTestId("supervisor-total-counter")).toContainText(
      "3"
    );

    await page.reload();
    await waitForConnected(page);
    await expect(page.getByText("Child Agents (2)")).toBeVisible();
    await expect(page.getByTestId("supervisor-total-counter")).toContainText(
      "3"
    );

    await childCards.first().getByLabel("Remove child agent").click();
    await expect(page.getByText("Child Agents (1)")).toBeVisible();

    await page.getByRole("button", { name: "Clear All" }).click();
    await expect(
      page.getByText(
        'No children yet. Click "Create Child" to spawn a new child agent.'
      )
    ).toBeVisible();
  });

  test("sql demo supports schema inspection, queries, inserts, and log clearing", async ({
    page
  }) => {
    await gotoDemo(page, "/core/sql");
    await waitForConnected(page);
    await clearLogs(page);

    await expect(page.getByRole("heading", { name: "Tables" })).toBeVisible();
    await page
      .getByTestId("sql-table-button")
      .filter({ hasText: "cf_agents_state" })
      .click();
    await expect(page.getByText(/Schema: cf_agents_state/)).toBeVisible();
    await expect(page.getByLabel("SQL query")).toHaveValue(
      /SELECT \* FROM cf_agents_state LIMIT 10/
    );

    await page.getByRole("button", { name: "Execute" }).click();
    await expect(page.getByText(/Results \(/)).toBeVisible();
    await expectEventLogToContain(page, "query_result");

    await page.getByLabel("Record key").fill("test-key");
    await page.getByLabel("Record value").fill("test-value");
    await page.getByRole("button", { name: "Insert" }).click();
    await expect(
      page.getByTestId("sql-record").filter({ hasText: "test-key" })
    ).toHaveCount(1);
    await expect(
      page.getByTestId("sql-record").filter({ hasText: "test-value" })
    ).toHaveCount(1);
    await expectEventLogToContain(page, "inserted");

    await clearLogs(page);
  });
});
