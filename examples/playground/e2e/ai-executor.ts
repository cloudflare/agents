import {
  expect,
  type Page,
  type BrowserContext,
  type Locator
} from "@playwright/test";
import { type AiAction, AI_CONFIG, getApiUrl, buildPrompt } from "./ai-config";
import type { Scenario } from "./parse-testing-md";

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function repairJson(text: string): string {
  // Convert JS regex literals to strings: "name": /pattern/ → "name": "pattern"
  let fixed = text.replace(/:\s*\/((?:[^/\\]|\\.)*)\//g, (_match, pattern) => {
    return `: "${String(pattern).replace(/\\/g, "\\\\")}"`;
  });
  // Fix double-closing brackets: }}] → ]]
  fixed = fixed.replace(/\}\}\]/g, "}]");
  // Fix trailing commas before ]
  fixed = fixed.replace(/,\s*\]/g, "]");
  return fixed;
}

async function isLocatorVisible(locator: Locator): Promise<boolean> {
  return locator
    .first()
    .isVisible()
    .catch(() => false);
}

function extractFirstJsonArray(text: string): string | null {
  const start = text.indexOf("[");
  if (start === -1) return null;
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === "[") depth++;
    else if (text[i] === "]") depth--;
    if (depth === 0) return text.slice(start, i + 1);
  }
  return null;
}

async function clickByName(
  page: Page,
  role: string,
  name: string
): Promise<void> {
  const exactLocator = page.getByRole(role as never, { name });
  if (await isLocatorVisible(exactLocator)) {
    await exactLocator.first().click();
    return;
  }

  if (role === "radio") {
    const byLabel = page.getByLabel(name);
    if (await isLocatorVisible(byLabel)) {
      await byLabel.first().click();
      return;
    }
  }

  const baseName = name.replace(/\(.*\)$/, "").trim();
  if (baseName !== name) {
    const fuzzyRole = page.getByRole(role as never, {
      name: new RegExp(escapeRegex(baseName), "i")
    });
    if (await isLocatorVisible(fuzzyRole)) {
      await fuzzyRole.first().click();
      return;
    }
  }

  const byLabel = page.getByLabel(name);
  if (await isLocatorVisible(byLabel)) {
    await byLabel.first().click();
    return;
  }

  const byText = page.getByText(name, { exact: false });
  if (await isLocatorVisible(byText)) {
    await byText.first().click();
    return;
  }

  await exactLocator.first().click();
}

async function fillByName(
  page: Page,
  role: string,
  name: string,
  value: string
): Promise<void> {
  const byRole = page.getByRole(role as never, { name });
  if (await isLocatorVisible(byRole)) {
    await byRole.first().fill(value);
    return;
  }

  const byLabel = page.getByLabel(name);
  if (await isLocatorVisible(byLabel)) {
    await byLabel.first().fill(value);
    return;
  }

  const byPlaceholder = page.getByPlaceholder(name);
  if (await isLocatorVisible(byPlaceholder)) {
    await byPlaceholder.first().fill(value);
    return;
  }

  await byRole.first().fill(value);
}

async function expectVisibleByName(
  page: Page,
  role: string,
  name: string
): Promise<void> {
  const slashMatch = name.match(/^\/(.+)\/$/);
  const visRegex = slashMatch
    ? new RegExp(slashMatch[1])
    : new RegExp(escapeRegex(name), "i");
  const byRole = page.getByRole(role as never, { name: visRegex });
  if (await isLocatorVisible(byRole)) {
    await expect(byRole.first()).toBeVisible({ timeout: 20_000 });
    return;
  }

  if (role === "textbox") {
    const byLabel = page.getByLabel(name);
    if (await isLocatorVisible(byLabel)) {
      await expect(byLabel.first()).toBeVisible({ timeout: 20_000 });
      return;
    }

    const byPlaceholder = page.getByPlaceholder(name);
    if (await isLocatorVisible(byPlaceholder)) {
      await expect(byPlaceholder.first()).toBeVisible({ timeout: 20_000 });
      return;
    }
  }

  const byLabel = page.getByLabel(name);
  if (await isLocatorVisible(byLabel)) {
    await expect(byLabel.first()).toBeVisible({ timeout: 20_000 });
    return;
  }

  await expect(byRole.first()).toBeVisible({ timeout: 20_000 });
}

async function callLlm(prompt: string): Promise<AiAction[]> {
  const url = getApiUrl();
  console.log(`[ai-executor] POST ${url} (prompt length: ${prompt.length})`);
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "x-api-key": AI_CONFIG.apiToken,
      "Content-Type": "application/json",
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model: AI_CONFIG.model,
      max_tokens: 8192,
      temperature: 0,
      messages: [{ role: "user", content: prompt }]
    })
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`LLM API error ${res.status}: ${body.slice(0, 500)}`);
  }

  const json = (await res.json()) as {
    content?: Array<{ type: string; text?: string }>;
    error?: { message: string };
  };

  if (json.error) {
    throw new Error(`LLM error: ${json.error.message}`);
  }

  const raw = json.content?.find((b) => b.type === "text")?.text ?? "";
  console.log(
    `[ai-executor] LLM response (${raw.length} chars): ${raw.slice(0, 300)}`
  );

  const jsonStr = extractFirstJsonArray(raw);
  if (!jsonStr) {
    throw new Error(
      `LLM returned no JSON array. Raw response:\n${raw.slice(0, 1000)}`
    );
  }

  try {
    return JSON.parse(jsonStr) as AiAction[];
  } catch {
    // Attempt JSON repair (regex literals, double brackets, trailing commas)
    try {
      return JSON.parse(repairJson(jsonStr)) as AiAction[];
    } catch (e) {
      throw new Error(
        `Failed to parse LLM JSON: ${e}\nExtracted: ${jsonStr.slice(0, 500)}`
      );
    }
  }
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

function toExpectText(pattern: string, testId = "demo-page"): AiAction {
  console.log(
    `[ai-executor] Converting to expect_text: testId="${testId}" pattern="${pattern}"`
  );
  return { action: "expect_text", testId, pattern } as AiAction;
}

function validateAction(action: AiAction): AiAction | null {
  const a = action as Record<string, unknown>;

  // Fix E: if action needs role but role is missing/invalid, convert to text check
  const needsRole = [
    "click",
    "fill",
    "check",
    "uncheck",
    "select_option",
    "expect_visible",
    "expect_hidden",
    "expect_text_role"
  ];
  if (needsRole.includes(a.action as string)) {
    if (!a.role || !VALID_ROLES.has(a.role as string)) {
      // If it has testId/pattern, convert to expect_text
      if (a.testId && a.pattern) {
        return toExpectText(a.pattern as string, a.testId as string);
      }
      if (a.pattern || a.name) {
        return toExpectText(
          (a.pattern as string) || (a.name as string),
          "demo-page"
        );
      }
      console.warn(
        `[ai-executor] Skipping action with invalid role: ${JSON.stringify(action)}`
      );
      return null;
    }
  }

  // Fix B: paragraphs have no accessible names — convert to text-based checks
  if (a.role === "paragraph") {
    if (
      a.action === "expect_visible" ||
      a.action === "expect_text_role" ||
      a.action === "expect_hidden"
    ) {
      const pattern = (a.pattern as string) || (a.name as string) || "";
      if (pattern) return toExpectText(pattern);
    }
  }

  // Fix B: heading with changing count — name won't match after action
  if (
    a.role === "heading" &&
    a.action === "expect_text_role" &&
    typeof a.name === "string" &&
    typeof a.pattern === "string" &&
    a.name !== a.pattern
  ) {
    console.log(
      `[ai-executor] Heading name "${a.name}" differs from pattern "${a.pattern}" — converting to expect_text`
    );
    return toExpectText(a.pattern as string);
  }

  // Fix A: normalize expect_log_contains — strip spaces around arrows
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
  pages: Page[],
  currentRoute: string
): Promise<Page> {
  switch (action.action) {
    case "click": {
      // Handle empty name: fall back to role-only match
      if (!action.name) {
        console.log(
          `[ai-executor] Empty name for role "${action.role}" — clicking first match`
        );
        await page
          .getByRole(action.role as never)
          .first()
          .click();
        break;
      }
      await clickByName(page, action.role, action.name);
      break;
    }

    case "click_testid":
      await page.getByTestId(action.testId).click();
      break;

    case "fill":
      await fillByName(page, action.role, action.name, action.value);
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

    case "expect_visible": {
      await expectVisibleByName(page, action.role, action.name);
      break;
    }

    case "expect_hidden":
      await expect(
        page.getByRole(action.role as never, { name: action.name }).first()
      ).toBeHidden({ timeout: 20_000 });
      break;

    case "expect_text": {
      // Fix 4: if pattern looks like /regex/, use it as a real regex
      const patternStr = action.pattern;
      const regexLiteral = patternStr.match(/^\/(.+)\/([gimsuy]*)$/);
      const textRegex = regexLiteral
        ? new RegExp(regexLiteral[1], regexLiteral[2] || "i")
        : new RegExp(escapeRegex(patternStr).replace(/ /g, "\\s*"), "i");
      await expect(page.getByTestId(action.testId).first()).toContainText(
        textRegex,
        { timeout: 20_000 }
      );
      break;
    }

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

    case "expect_log_contains": {
      const logLocator = page.getByTestId("event-log");
      const searchText = action.text;
      // Build alternatives for flexible matching
      const alts: string[] = [escapeRegex(searchText)];
      // Strip leading arrows and type prefixes
      const stripped = searchText
        .replace(/^[→←•]\s*/, "")
        .replace(
          /^(call|result|chunk|stream_start|stream_done|state_update|error)\s*/,
          ""
        );
      if (stripped !== searchText) alts.push(escapeRegex(stripped));
      // Fix 3: handle callable RPC format — callMethodName() → "method":"MethodName"
      const callMatch = searchText.match(
        /^(?:[→←•]\s*)?call([A-Za-z_][A-Za-z0-9_]*)\(/
      );
      if (callMatch) {
        alts.push(`"method"\\s*:\\s*"${escapeRegex(callMatch[1])}"`);
      }
      if (searchText === "workflow_step_complete") {
        alts.push("workflow_progress");
      }
      // Also handle single-quote vs double-quote mismatches
      const withDoubleQuotes = searchText.replace(/'/g, '"');
      if (withDoubleQuotes !== searchText) {
        alts.push(escapeRegex(withDoubleQuotes));
      }
      await expect(logLocator).toContainText(new RegExp(alts.join("|"), "i"), {
        timeout: 20_000
      });
      break;
    }

    case "expect_url":
      await expect(page).toHaveURL(new RegExp(action.pattern));
      break;

    case "wait":
      await page.waitForTimeout(Math.min(action.ms, 10_000));
      break;

    case "reload":
      await page.reload();
      break;

    case "new_tab": {
      const newPage = await context.newPage();
      pages.push(newPage);
      // Fix D: auto-navigate to the current route so the page is ready
      if (currentRoute) {
        await newPage.goto(currentRoute);
        await expect(newPage.getByTestId("demo-page")).toBeVisible({
          timeout: 20_000
        });
      }
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
    activePage = await executeAction(
      validated,
      activePage,
      context,
      pages,
      route
    );
  }

  // Clean up any extra tabs
  for (let i = pages.length - 1; i > 0; i--) {
    if (!pages[i].isClosed()) {
      await pages[i].close();
    }
  }
}
