import { expect, type Page, type BrowserContext } from "@playwright/test";
import { type AiAction, AI_CONFIG, getApiUrl, buildPrompt } from "./ai-config";
import type { Scenario } from "./parse-testing-md";

async function callLlm(prompt: string): Promise<AiAction[]> {
  const url = getApiUrl();
  console.log(`[ai-executor] POST ${url} (prompt length: ${prompt.length})`);
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${AI_CONFIG.apiToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      messages: [{ role: "user", content: prompt }],
      max_tokens: 8192,
      temperature: 0
    })
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`LLM API error ${res.status}: ${body.slice(0, 500)}`);
  }

  const json = (await res.json()) as {
    result?: { response?: unknown };
    errors?: Array<{ message: string }>;
  };

  const raw = json.result?.response;

  // Workers AI auto-parses JSON responses into objects/arrays
  if (Array.isArray(raw)) {
    console.log(
      `[ai-executor] LLM response (array, ${raw.length} items): ${JSON.stringify(raw).slice(0, 300)}`
    );
    return raw as AiAction[];
  }

  if (typeof raw === "string") {
    console.log(
      `[ai-executor] LLM response (string, ${raw.length} chars): ${raw.slice(0, 300)}`
    );
    const jsonMatch = raw.match(/\[[\s\S]*\]/);
    if (!jsonMatch) {
      throw new Error(
        `LLM returned no JSON array. Raw response:\n${raw.slice(0, 1000)}`
      );
    }
    try {
      return JSON.parse(jsonMatch[0]) as AiAction[];
    } catch (e) {
      throw new Error(
        `Failed to parse LLM JSON: ${e}\nExtracted: ${jsonMatch[0].slice(0, 500)}`
      );
    }
  }

  // Single object response — wrap in array
  if (raw && typeof raw === "object") {
    console.log(
      `[ai-executor] LLM response (object): ${JSON.stringify(raw).slice(0, 300)}`
    );
    return [raw] as AiAction[];
  }

  throw new Error(
    `Unexpected LLM response type: ${typeof raw} — ${JSON.stringify(raw).slice(0, 500)}`
  );
}

async function getSnapshot(page: Page): Promise<string> {
  try {
    return await page.locator("body").ariaSnapshot({ timeout: 10_000 });
  } catch {
    const html = await page.content();
    return html.slice(0, 8000);
  }
}

const VALID_ROLES = new Set([
  "alert",
  "alertdialog",
  "application",
  "article",
  "banner",
  "blockquote",
  "button",
  "caption",
  "cell",
  "checkbox",
  "code",
  "columnheader",
  "combobox",
  "complementary",
  "contentinfo",
  "definition",
  "deletion",
  "dialog",
  "directory",
  "document",
  "emphasis",
  "feed",
  "figure",
  "form",
  "generic",
  "grid",
  "gridcell",
  "group",
  "heading",
  "img",
  "insertion",
  "link",
  "list",
  "listbox",
  "listitem",
  "log",
  "main",
  "marquee",
  "math",
  "meter",
  "menu",
  "menubar",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "navigation",
  "none",
  "note",
  "option",
  "paragraph",
  "presentation",
  "progressbar",
  "radio",
  "radiogroup",
  "region",
  "row",
  "rowgroup",
  "rowheader",
  "scrollbar",
  "search",
  "searchbox",
  "separator",
  "slider",
  "spinbutton",
  "status",
  "strong",
  "subscript",
  "superscript",
  "switch",
  "tab",
  "table",
  "tablist",
  "tabpanel",
  "term",
  "textbox",
  "time",
  "timer",
  "toolbar",
  "tooltip",
  "tree",
  "treegrid",
  "treeitem"
]);

function validateAction(action: AiAction): AiAction | null {
  const a = action as Record<string, unknown>;
  if ("role" in a && (!a.role || !VALID_ROLES.has(a.role as string))) {
    console.warn(
      `[ai-executor] Skipping action with invalid role: ${JSON.stringify(action)}`
    );
    return null;
  }
  // Normalize expect_log_contains: strip spaces around arrows
  if (a.action === "expect_log_contains" && typeof a.text === "string") {
    a.text = (a.text as string)
      .replace(/\s*→\s*/g, "→")
      .replace(/\s*←\s*/g, "←")
      .replace(/\s*•\s*/g, "•");
  }
  return action;
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
      await expect(page.getByTestId(action.testId).first()).toContainText(
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

  console.log(`[ai-executor] Navigating to ${route}`);
  await page.goto(route);
  await expect(page.getByTestId("demo-page")).toBeVisible({ timeout: 20_000 });
  console.log(`[ai-executor] Page loaded`);

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

  console.log(`[ai-executor] Snapshot length: ${snapshot.length}`);
  const prompt = buildPrompt(scenario, snapshot, helpers);
  const actions = await callLlm(prompt);
  console.log(`[ai-executor] Got ${actions.length} actions`);

  const pages: Page[] = [page];
  let activePage = page;

  for (let i = 0; i < actions.length; i++) {
    console.log(
      `[ai-executor] Action ${i + 1}/${actions.length}: ${JSON.stringify(actions[i])}`
    );
    const validated = validateAction(actions[i]);
    if (!validated) continue;
    activePage = await executeAction(validated, activePage, context, pages);
  }

  // Clean up any extra tabs
  for (let i = pages.length - 1; i > 0; i--) {
    if (!pages[i].isClosed()) {
      await pages[i].close();
    }
  }
}
