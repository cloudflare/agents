import type { Scenario } from "./parse-testing-md";

export type AiAction =
  | { action: "click"; role: string; name: string }
  | { action: "fill"; role: string; name: string; value: string }
  | { action: "check"; role: string; name: string }
  | { action: "uncheck"; role: string; name: string }
  | { action: "select_option"; role: string; name: string; value: string }
  | { action: "press_key"; key: string }
  | { action: "expect_visible"; role: string; name: string }
  | { action: "expect_text"; testId: string; pattern: string }
  | { action: "expect_text_role"; role: string; name: string; pattern: string }
  | { action: "expect_attribute"; testId: string; attr: string; value: string }
  | { action: "expect_count"; testId: string; count: number }
  | { action: "expect_url"; pattern: string }
  | { action: "wait"; ms: number }
  | { action: "reload" }
  | { action: "new_tab" }
  | { action: "switch_tab"; index: number }
  | { action: "close_tab"; index: number }
  | { action: "emulate_media"; colorScheme: "light" | "dark" }
  | { action: "click_testid"; testId: string }
  | { action: "expect_hidden"; role: string; name: string }
  | {
      action: "expect_log_contains";
      text: string;
    };

export const AI_CONFIG = {
  apiUrl:
    process.env.AI_API_URL ??
    "https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/run/@cf/meta/llama-4-scout-17b-16e-instruct",
  apiToken: process.env.CLOUDFLARE_API_TOKEN ?? "",
  accountId: process.env.CLOUDFLARE_ACCOUNT_ID ?? "",
  maxRetries: 2,
  scenarioTimeout: 60_000
};

export function getApiUrl(): string {
  return AI_CONFIG.apiUrl.replace("{account_id}", AI_CONFIG.accountId);
}

export function buildPrompt(
  scenario: Scenario,
  snapshot: string,
  helpers: string[]
): string {
  const routeNote =
    scenario.route === "/ai/codemode"
      ? '\nIMPORTANT: For the codemode demo, append "?e2e=1" to the route (navigate to "/ai/codemode?e2e=1"). This activates mock mode for deterministic testing.'
      : "";

  const multiTabNote = scenario.flags.includes("multi-tab")
    ? `\nThis scenario requires MULTIPLE BROWSER TABS. Use "new_tab" to open a second tab, "switch_tab" to switch between them (index 0 = first, 1 = second), and "close_tab" to close one. Each tab shares the same browser context (cookies, localStorage). After "new_tab", you are automatically on the new tab — navigate it to the route before interacting.`
    : "";

  return `You are a Playwright E2E test executor. Given a test scenario and a page accessibility snapshot, output a JSON array of actions to execute the test.

## Available actions

- { "action": "click", "role": "<role>", "name": "<accessible name>" }
- { "action": "fill", "role": "<role>", "name": "<accessible name>", "value": "<text>" }
- { "action": "check", "role": "<role>", "name": "<accessible name>" }
- { "action": "uncheck", "role": "<role>", "name": "<accessible name>" }
- { "action": "select_option", "role": "<role>", "name": "<accessible name>", "value": "<option text>" }
- { "action": "press_key", "key": "<key name e.g. Enter>" }
- { "action": "click_testid", "testId": "<data-testid value>" }
- { "action": "expect_visible", "role": "<role>", "name": "<accessible name or regex>" }
- { "action": "expect_hidden", "role": "<role>", "name": "<accessible name>" }
- { "action": "expect_text", "testId": "<data-testid>", "pattern": "<text or regex>" }
- { "action": "expect_text_role", "role": "<role>", "name": "<accessible name>", "pattern": "<text>" }
- { "action": "expect_attribute", "testId": "<data-testid>", "attr": "<attribute>", "value": "<value>" }
- { "action": "expect_count", "testId": "<data-testid>", "count": <number> }
- { "action": "expect_log_contains", "text": "<text to find in event log>" }
- { "action": "expect_url", "pattern": "<url pattern>" }
- { "action": "wait", "ms": <milliseconds> }
- { "action": "reload" }
- { "action": "new_tab" }
- { "action": "switch_tab", "index": <0-based tab index> }
- { "action": "close_tab", "index": <0-based tab index> }
- { "action": "emulate_media", "colorScheme": "light" | "dark" }

## Event log rendered text format

The event log renders each entry as: "{time}{arrow}{type}{content}" with NO spaces between parts.
- Outgoing calls: "→" arrow, e.g. "→callincrement()" or "→callsetCounter(42)" or "→setState{'counter':100}"
- Incoming results: "←" arrow, e.g. "←result8" or "←chunk{'number':1}" or "←stream_done{...}"
- Info events: "•" dot, e.g. "•connected"

When using expect_log_contains, use a SHORT substring that appears in the rendered text.
Good examples: "callincrement()" or "result8" or "setState" or "stream_start" or "chunk"
Bad examples: "call → increment()" (spaces don't exist) or "chunk ←" (arrow is before the word)

## Rules

1. Output ONLY a valid JSON array. No markdown, no explanation, no comments.
2. Use roles and accessible names EXACTLY as they appear in the snapshot.
3. For assertions, prefer data-testid when the snapshot shows one.
4. The page is already navigated to the route — do NOT include a navigation action unless the scenario explicitly requires reload or navigation to a different page.
5. For event log assertions, ALWAYS use { "action": "expect_log_contains", "text": "<substring>" }. NEVER use "expect_text" or "expect_text_role" for event log content.
6. Keep the action list minimal — only what's needed to execute the scenario.
7. For "name" fields in actions, use EXACT text from the snapshot. Do NOT guess or paraphrase.
8. Use "wait" sparingly — only when the scenario explicitly mentions delays.
9. When the scenario says to reset or clear state first, include those actions at the beginning.
10. For expect_log_contains, use a short distinctive substring from the RENDERED text format above — no timestamps, no spaces around arrows.
11. NEVER pass the scenario's expected outcome text literally as an assertion pattern. Translate it into the actual UI text or testId-based check.
12. Every action that uses "role" MUST have a valid ARIA role (e.g. "button", "heading", "textbox", "spinbutton", "checkbox", "link", "list", "listitem"). Never use undefined or empty string.
13. NEVER use getByRole("paragraph"). Paragraphs do NOT have accessible names — their text content is NOT their name. To check if text is visible on the page, use { "action": "expect_text", "testId": "demo-page", "pattern": "<text>" } instead.
${routeNote}${multiTabNote}

## Scenario

**${scenario.category} / ${scenario.section} / ${scenario.title}**

Action:
${scenario.action.map((a) => `- ${a}`).join("\n")}

Expected:
${scenario.expected.map((e) => `- ${e}`).join("\n")}
${scenario.notes.length > 0 ? `\nNotes:\n${scenario.notes.map((n) => `- ${n}`).join("\n")}` : ""}

## Available helpers on the page

${helpers.join("\n")}

## Current page accessibility snapshot

\`\`\`
${snapshot}
\`\`\`

## Output

Return ONLY a JSON array of actions:`;
}
