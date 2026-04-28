import { expect, type Locator, type Page } from "@playwright/test";

/**
 * Shared selectors and waits for the agents-as-tools e2e suite.
 *
 * Centralizes the data-testid contracts and a few "wait for X to be
 * meaningful" helpers so the tests themselves read as user steps,
 * not as DOM gymnastics. Keep this file thin — anything that grows
 * into per-test logic should live in the test file.
 */

/**
 * Generate a per-test Assistant-DO user name. Each test opens
 * the page with `?user=<unique>` so the Assistant DO is fresh —
 * no helper-rows / chat-history / pending-alarm state from a
 * previous test bleeds in. Combined with `clearHelperRuns` /
 * `clearHistory()` at test start, this is hermetic enough that
 * tests can run repeatedly without `rm -rf .wrangler/state`.
 *
 * Why uniqueness matters here: alarms inside helper facets in
 * the current framework lose `ctx.id.name` when they fire after
 * a dev-server restart (a deeper `partyserver` / facet-alarm
 * interaction). Each test's fresh DO has no in-flight alarms,
 * sidestepping the symptom while the upstream is fixed.
 */
export function uniqueUser(): string {
  return `e2e-${Math.random().toString(36).slice(2, 10)}-${Date.now()}`;
}

/**
 * Navigate to the page with a fresh user id. Tests should call this
 * instead of `page.goto("/")` so each test runs against its own
 * Assistant DO. Returns the user name so tests can assert on it
 * if they need to (e.g. for cross-tab refresh tests).
 */
export async function gotoFresh(page: Page): Promise<string> {
  const user = uniqueUser();
  await page.goto(`/?user=${user}`);
  return user;
}

/** The composer in the parent chat. Distinct from drill-in's composer. */
export function parentComposer(page: Page): Locator {
  return page.getByPlaceholder("Ask for research on a topic…");
}

/** The composer inside the open drill-in side panel (when known helper). */
export function drillInComposer(page: Page): Locator {
  return page.getByPlaceholder("Continue the conversation with this helper…");
}

/** All inline helper panels currently on the page (one per helper run). */
export function helperPanels(page: Page): Locator {
  return page.getByTestId("helper-panel");
}

/** The single helper panel for a given helper class (Researcher / Planner). */
export function helperPanelByType(page: Page, helperType: string): Locator {
  return page
    .getByTestId("helper-panel")
    .and(page.locator(`[data-helper-type="${helperType}"]`));
}

/** The drill-in side panel, when open. */
export function drillInPanel(page: Page): Locator {
  return page.getByTestId("drill-in-panel");
}

/**
 * Submit a message via the parent composer. Waits for the composer
 * to be enabled first — important when sending consecutive messages
 * because the previous turn's LLM call may still be wrapping up
 * (the helper panel can reach `done` slightly before the parent's
 * outer turn finishes synthesizing its reply, which is when the
 * composer un-disables). 60s is generous but bounded.
 */
export async function sendMessage(page: Page, text: string): Promise<void> {
  const composer = parentComposer(page);
  await expect(composer).toBeEnabled({ timeout: 60_000 });
  await composer.fill(text);
  await composer.press("Enter");
}

/**
 * Wait for the chat to be reachable. The composer becomes enabled
 * once Think's WS handshake completes and `useAgentChat`'s `status`
 * flips to "ready". Without this wait, an early `sendMessage` can
 * land before the connection is wired and just disappear.
 */
export async function waitForChatReady(page: Page): Promise<void> {
  await expect(parentComposer(page)).toBeEnabled({ timeout: 30_000 });
}

/**
 * Wait for at least one helper panel of the given class to render.
 * This is the "the LLM picked the right tool" beat in tests — we
 * don't assert the whole tool-call lifecycle, just that the helper
 * spawned. Subsequent assertions (status badge, drill-in, etc.) can
 * happen against the resolved locator.
 *
 * Timeout is generous (90s) because the wait window has to cover
 * the parent's first-token latency on Workers AI (which can be
 * 5-30s for `kimi-k2.5`) plus the time to actually pick a tool
 * and emit the synthesized `started` event the panel renders from.
 */
export async function waitForHelperOfType(
  page: Page,
  helperType: string
): Promise<Locator> {
  const panel = helperPanelByType(page, helperType).first();
  await expect(panel).toBeVisible({ timeout: 90_000 });
  return panel;
}

/**
 * Wait for the helper panel to settle into a terminal state ("Done"
 * badge or "Error" badge). The `data-helper-status` attribute is the
 * cleanest hook: it's "running" while the helper is mid-stream and
 * flips to "done" / "error" on the synthesized terminal event.
 *
 * Helper turns (the helper's OWN inference loop, separate from the
 * parent's tool-selection loop) can take a while — especially when
 * the helper has its own internal tool calls to make. 90s.
 */
export async function waitForHelperTerminal(panel: Locator): Promise<void> {
  await expect(panel).toHaveAttribute("data-helper-status", /^(done|error)$/, {
    timeout: 90_000
  });
}

/**
 * Click the ↗ (drill-in) button on a helper panel. The button's
 * accessible name is `"Drill in to ${helperType}"`. We click via
 * the role lookup scoped to the panel, so duplicate panels (e.g.
 * `compare`'s two Researchers) don't ambiguously match.
 */
export async function openDrillIn(panel: Locator): Promise<void> {
  await panel.getByRole("button", { name: /^Drill in to / }).click();
}

/**
 * Click the Clear button in the parent header. Wipes both chat
 * history and the helper-runs registry.
 */
export async function clickClear(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Clear" }).click();
}
