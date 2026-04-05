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
  | {
      action: "expect_role_attribute";
      role: string;
      name: string;
      attr: string;
      value: string;
    }
  | { action: "expect_attribute"; testId: string; attr: string; value: string }
  | { action: "expect_document_attribute"; attr: string; value: string }
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
    "https://gateway.ai.cloudflare.com/v1/{account_id}/{gateway_id}/anthropic/v1/messages",
  apiToken: process.env.CLOUDFLARE_API_TOKEN ?? "",
  accountId: process.env.CLOUDFLARE_ACCOUNT_ID ?? "",
  gatewayId: process.env.CLOUDFLARE_GATEWAY_ID ?? "",
  model: "claude-opus-4-6",
  maxRetries: 2,
  scenarioTimeout: 60_000
};

export function getApiUrl(): string {
  return AI_CONFIG.apiUrl
    .replace("{account_id}", AI_CONFIG.accountId)
    .replace("{gateway_id}", AI_CONFIG.gatewayId);
}

export function buildPrompt(
  scenario: Scenario,
  snapshot: string,
  helpers: string[]
): string {
  const scenarioNotes: string[] = [];

  if (scenario.flags.includes("global-ui")) {
    scenarioNotes.push(
      'This scenario runs on the shared home page at "/". There is NO `data-testid="demo-page"` and NO `connection-status` on this page.'
    );
  }

  if (scenario.route === "/ai/codemode") {
    scenarioNotes.push(
      "The runner already opens codemode in deterministic E2E mode at `/ai/codemode?e2e=1`."
    );
    scenarioNotes.push(
      'This page does NOT have an event log. Codemode tool execution appears as expandable cards with `data-testid="codemode-tool-card"` and `data-testid="codemode-tool-toggle"`.'
    );
    scenarioNotes.push(
      'In E2E mode, sending "What is 17 + 25?" yields an assistant reply mentioning `42` and a completed `Ran code` tool card.'
    );
  }

  if (scenario.route === "/ai/tools") {
    scenarioNotes.push(
      "On initial page load, approval buttons like `Approve` and `Reject` are NOT visible. They only appear after sending a prompt that triggers an approval-required tool."
    );
  }

  if (scenario.route === "/core/callable") {
    scenarioNotes.push(
      "After `listMethods()`, the page renders an `Available Methods` card and a `Last Result` card below the utility buttons. Prefer asserting the visible card on the page, not only the event log."
    );
  }

  if (scenario.route === "/multi-agent/supervisor") {
    scenarioNotes.push(
      "Supervisor child cards show a bare numeric counter like `0`, not text such as `Counter: 0`."
    );
    scenarioNotes.push("The `Clear All` control is a button, not a link.");
    scenarioNotes.push(
      "The `Clear All` button only appears after at least one child exists. Create a child first when needed."
    );
  }

  if (scenario.route === "/core/retry") {
    scenarioNotes.push(
      "When `retryFlaky(10)` exhausts retries, the visible terminal error is the last failure message like `Transient failure on attempt 3`. Do not invent a separate `all retries exhausted` banner."
    );
    scenarioNotes.push(
      "Unchecked checkboxes usually have NO `checked` attribute. Do not assert `checked=false`; validate the retry outcome instead."
    );
  }

  if (scenario.route === "/ai/chat") {
    scenarioNotes.push(
      "On page load, the empty state shows `Start a conversation` with weather/timezone suggestions. The docs content includes `Create an AI chat agent` and `Connect with useAgentChat`."
    );
  }

  if (scenario.route === "/workflow/basic") {
    scenarioNotes.push(
      "For multi-workflow scenarios, prefer starting exactly two workflows with visible names like `Data Processing` and `Email Notification` rather than inventing extra names."
    );
  }

  if (scenario.route === "/workflow/approval") {
    scenarioNotes.push(
      "For approval scenarios, use visible preset titles such as `Deploy to Production` and `Access Request - Admin Panel` for deterministic requests."
    );
    scenarioNotes.push(
      "For clear-history scenarios, create and resolve two requests first, confirm `History (2)`, then click `Clear`."
    );
  }

  const multiTabNote = scenario.flags.includes("multi-tab")
    ? `\nThis scenario requires MULTIPLE BROWSER TABS. Use "new_tab" to open a second tab, "switch_tab" to switch between them (index 0 = first, 1 = second), and "close_tab" to close one. Each tab shares the same browser context (cookies, localStorage). After "new_tab", you are automatically on the new tab — navigate it to the route before interacting.`
    : "";

  const contextNote =
    scenarioNotes.length > 0
      ? `\n${scenarioNotes.map((note) => `- ${note}`).join("\n")}`
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
- { "action": "expect_role_attribute", "role": "<role>", "name": "<accessible name>", "attr": "<attribute>", "value": "<value>" }
- { "action": "expect_attribute", "testId": "<data-testid>", "attr": "<attribute>", "value": "<value>" }
- { "action": "expect_document_attribute", "attr": "<attribute>", "value": "<value>" }
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
- State management calls: "→callincrement()" or "→callsetCounter(42)" or "→setState{'counter':100}"
- Callable RPC calls: "→call{'method':'add','args':[5,3]}" (JSON object after "call")
- Stream starts: "→stream_start{'method':'streamNumbers','args':[10]}"
- Results: "←result8" or "←resultEcho: Hello World"
- Chunks: "←chunk{'number':1,'progress':'1/10'}"
- Stream done: "←stream_done{'total':10,'message':'Stream complete'}"
- Info events: "•connected"

When using expect_log_contains, use a SHORT substring that appears in the rendered text.
Good examples: "callincrement()" or "result8" or "setState" or "stream_start" or "chunk" or "add"
Bad examples: "call → increment()" (spaces don't exist) or "→increment()" (missing 'call' prefix)

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
13. NEVER use getByRole("paragraph"). Paragraphs do NOT have accessible names — their text content is NOT their name. To check if text is visible on the page, use { "action": "expect_text", "testId": "<stable container from helpers>", "pattern": "<text>" } instead.
14. After "new_tab", the new tab is automatically navigated to the current route. Do NOT include a navigation action after new_tab.
15. For headings whose text changes (e.g. "Items (0)" → "Items (1)"), do NOT use expect_text_role with the OLD heading text as the name. Use { "action": "expect_text", "testId": "demo-page", "pattern": "Items (1)" } instead.
16. NEVER use JavaScript regex literals like /pattern/ in JSON values. All values must be quoted strings. Write "Counter: 42" not /Counter: 42/. For regex matching, put the pattern inside a string.
17. Stat boxes (like on the Supervisor page) render number and label in SEPARATE divs. Playwright text extraction concatenates them WITHOUT spaces: "<div>0</div><div>Children</div>" becomes "0Children". Always write patterns WITHOUT spaces between a number and its label: "1Children" not "Children 1" or "1 Children", "0Total Counter" not "0 Total Counter".
18. Radio buttons (Radio.Item) have accessible labels like "Per-User — Each user ID gets their own agent instance". Use the FULL label text from the snapshot as the name. NEVER use an empty string for a radio button name.
19. Do NOT assert transient button states that only appear briefly during an async operation (e.g. "Streaming..." on a button that reverts to its original text in under a second). Instead, assert the RESULT of the operation (e.g. chunks appearing, final result, stream_done in the event log).
20. If an element has an aria-label, that aria-label IS the accessible name. Do NOT use placeholder text, icon text, or visual text instead. Examples: use "Remove child agent" instead of "×", use "Chat message" instead of "Type a message...", use the exact button text "Cancel" instead of inventing "Cancel workflow".
21. Chat room list items have data-testid "chat-room-button" and visible room text like "General 1 online". Prefer deterministic selectors like click_testid when possible, and do NOT guess room names or counts that are not visible in the snapshot.
22. In the workflow/basic demo, the event log uses names like "workflow_started", "workflow_progress", "workflow_complete", and "workflow_cancelled". Do NOT invent event names like "workflow_step_complete".
23. In the Supervisor demo, there is a GLOBAL "+1 to All" button and PER-CHILD "+1" buttons inside each child card. For a single-child action, do NOT use the global "+1 to All" control.
24. Never use a wait longer than 5000ms. Prefer assertions that wait for visible results over long fixed delays.
25. NEVER assert transient button labels like "Streaming..." or "Submitting...". Those states are too brief and flaky. Assert durable results instead, such as chunks appearing, log events, pending/history counts, or final text.
26. For timestamps or dynamic clock text, do NOT assert raw regex fragments like ":\\d{2}" against the whole page. Assert the durable message content around the timestamp instead.
27. Do NOT use expect_attribute on testId "demo-page". The root demo container does not expose scenario-specific state as attributes. To verify routing, prefer the specific testIds shown in the snapshot like "routing-agent-instance" or visible text.
28. For approval workflow tests that need a pending request, create one deterministically: fill "Title", fill "Description", click "Submit Request", then assert "Pending Approval (1)" before approving or rejecting.
29. For chat room buttons, if you see text like "General 1 online", the stable room identity is the room name (e.g. "General"), not the member count. Do NOT rely on the count being exact when choosing the room.
30. Only use "expect_log_contains" when the helpers list explicitly includes "data-testid=event-log".
31. For sidebar active-state checks, prefer "expect_role_attribute" with "aria-current=page" on the active link.
32. For theme checks, prefer "expect_document_attribute" with "data-mode" or "data-theme-preference" on document.documentElement.
33. Only use data-testid values that are explicitly listed in the helpers section below. Do NOT invent new test IDs.
34. Use the correct control role from the snapshot. If the snapshot shows a control as a button, do NOT call it a link.
35. For unchecked checkboxes, do NOT assert a literal "checked=false" attribute. Unchecked controls usually omit the attribute entirely.
${contextNote}${multiTabNote}

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
