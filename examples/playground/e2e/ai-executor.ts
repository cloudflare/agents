import { expect, type Page, type BrowserContext } from "@playwright/test";
import { type AiAction, AI_CONFIG, getApiUrl, buildPrompt } from "./ai-config";
import type { Scenario } from "./parse-testing-md";

async function callLlm(prompt: string): Promise<AiAction[]> {
  const url = getApiUrl();
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${AI_CONFIG.apiToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      messages: [{ role: "user", content: prompt }],
      max_tokens: 4096,
      temperature: 0
    })
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`LLM API error ${res.status}: ${body}`);
  }

  const json = (await res.json()) as {
    result?: { response?: string };
    errors?: Array<{ message: string }>;
  };

  const raw = json.result?.response ?? "";
  const jsonMatch = raw.match(/\[[\s\S]*\]/);
  if (!jsonMatch) {
    throw new Error(`LLM returned no JSON array. Raw response:\n${raw}`);
  }

  return JSON.parse(jsonMatch[0]) as AiAction[];
}

async function getSnapshot(page: Page): Promise<string> {
  try {
    return await page.locator("body").ariaSnapshot({ timeout: 10_000 });
  } catch {
    const html = await page.content();
    return html.slice(0, 8000);
  }
}

async function executeAction(
  action: AiAction,
  page: Page,
  context: BrowserContext,
  pages: Page[]
): Promise<Page> {
  switch (action.action) {
    case "click":
      await page.getByRole(action.role as never, { name: action.name }).click();
      break;

    case "click_testid":
      await page.getByTestId(action.testId).click();
      break;

    case "fill":
      await page
        .getByRole(action.role as never, { name: action.name })
        .fill(action.value);
      break;

    case "check":
      await page.getByRole(action.role as never, { name: action.name }).check();
      break;

    case "uncheck":
      await page
        .getByRole(action.role as never, { name: action.name })
        .uncheck();
      break;

    case "select_option":
      await page
        .getByRole(action.role as never, { name: action.name })
        .selectOption(action.value);
      break;

    case "press_key":
      await page.keyboard.press(action.key);
      break;

    case "expect_visible":
      await expect(
        page
          .getByRole(action.role as never, { name: new RegExp(action.name) })
          .first()
      ).toBeVisible({ timeout: 20_000 });
      break;

    case "expect_hidden":
      await expect(
        page.getByRole(action.role as never, { name: action.name }).first()
      ).toBeHidden({ timeout: 20_000 });
      break;

    case "expect_text":
      await expect(page.getByTestId(action.testId)).toContainText(
        action.pattern,
        { timeout: 20_000 }
      );
      break;

    case "expect_text_role":
      await expect(
        page.getByRole(action.role as never, { name: action.name }).first()
      ).toContainText(action.pattern, { timeout: 20_000 });
      break;

    case "expect_attribute":
      await expect(page.getByTestId(action.testId)).toHaveAttribute(
        action.attr,
        action.value,
        { timeout: 20_000 }
      );
      break;

    case "expect_count":
      await expect(page.getByTestId(action.testId)).toHaveCount(action.count, {
        timeout: 20_000
      });
      break;

    case "expect_log_contains":
      await expect(page.getByTestId("event-log")).toContainText(action.text, {
        timeout: 20_000
      });
      break;

    case "expect_url":
      await expect(page).toHaveURL(new RegExp(action.pattern));
      break;

    case "wait":
      await page.waitForTimeout(action.ms);
      break;

    case "reload":
      await page.reload();
      break;

    case "new_tab": {
      const newPage = await context.newPage();
      pages.push(newPage);
      return newPage;
    }

    case "switch_tab": {
      const target = pages[action.index];
      if (!target) throw new Error(`No tab at index ${action.index}`);
      await target.bringToFront();
      return target;
    }

    case "close_tab": {
      const toClose = pages[action.index];
      if (!toClose) throw new Error(`No tab at index ${action.index}`);
      await toClose.close();
      pages.splice(action.index, 1);
      return pages[Math.min(action.index, pages.length - 1)] ?? page;
    }

    case "emulate_media":
      await page.emulateMedia({ colorScheme: action.colorScheme });
      break;
  }
  return page;
}

export async function executeScenario(
  scenario: Scenario,
  page: Page,
  context: BrowserContext
): Promise<void> {
  const route =
    scenario.route === "/ai/codemode"
      ? "/ai/codemode?e2e=1"
      : (scenario.route ?? "/");

  await page.goto(route);
  await expect(page.getByTestId("demo-page")).toBeVisible({ timeout: 20_000 });

  if (
    scenario.route &&
    ![
      "/ai/chat",
      "/ai/tools",
      "/mcp/server",
      "/mcp/client",
      "/mcp/oauth",
      "/multi-agent/workers",
      "/multi-agent/pipeline"
    ].includes(scenario.route)
  ) {
    await expect(page.getByTestId("connection-status")).toHaveAttribute(
      "data-status",
      "connected",
      { timeout: 20_000 }
    );
  }

  const snapshot = await getSnapshot(page);

  const helpers = [
    'data-testid="demo-page" — the main demo wrapper',
    'data-testid="demo-title" — the demo page title',
    'data-testid="connection-status" with data-status="connected|connecting|disconnected"',
    'data-testid="event-log" — the event log panel',
    'data-testid="event-log-entry" — individual log entries (with data-direction="in|out|error|info")',
    'data-testid="event-log-entries" — the scrollable log container',
    'data-testid="event-log-empty" — shown when log is empty',
    'data-testid="theme-toggle" — the dark/light/system theme toggle button',
    'data-testid="sidebar-nav" — the sidebar navigation',
    'data-testid="sidebar-category-core" etc. — category toggle buttons'
  ];

  const prompt = buildPrompt(scenario, snapshot, helpers);
  const actions = await callLlm(prompt);

  const pages: Page[] = [page];
  let activePage = page;

  for (const action of actions) {
    activePage = await executeAction(action, activePage, context, pages);
  }

  // Clean up any extra tabs
  for (let i = pages.length - 1; i > 0; i--) {
    if (!pages[i].isClosed()) {
      await pages[i].close();
    }
  }
}
