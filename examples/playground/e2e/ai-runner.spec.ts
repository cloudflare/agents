import { test } from "@playwright/test";
import { loadScenarios, type Scenario } from "./parse-testing-md";
import { executeScenario } from "./ai-executor";
import { AI_CONFIG } from "./ai-config";

const EXCLUDED_SCENARIOS = new Set([
  "Core Demos / Connections / Multi-Tab Count",
  "Core Demos / Routing Strategies / Strategy Persistence",
  "Multi-Agent Demos / Supervisor Pattern / Increment Single Child",
  "Multi-Agent Demos / Chat Rooms / Room Persistence",
  "Workflow Demos / Workflow Simulation / Cancel Workflow",
  "Workflow Demos / Approval Workflow / Reject Request",
  "Email Demos / Readonly Connections / Dual Panel Layout",
  "Email Demos / Readonly Connections / Editor Increment",
  "Email Demos / Readonly Connections / Viewer Blocked (Callable)",
  "Email Demos / Readonly Connections / Viewer Blocked (Client setState)",
  "Email Demos / Readonly Connections / Check Permissions (Always Allowed)",
  "Email Demos / Secure Email Replies / Clear Emails",
  "Email Demos / Readonly Connections / Toggle Readonly",
  "Core Demos / Routing Strategies / Per-User Strategy",
  "Multi-Agent Demos / Chat Rooms / Lobby Connection",
  "Multi-Agent Demos / Chat Rooms / Leave Room"
]);

const scenarios = loadScenarios().filter(
  (scenario) =>
    !EXCLUDED_SCENARIOS.has(
      `${scenario.category} / ${scenario.section} / ${scenario.title}`
    )
);

const SKIP_FLAGS = new Set(["deployed-only"]);

function shouldSkip(scenario: Scenario): string | false {
  for (const flag of scenario.flags) {
    if (SKIP_FLAGS.has(flag)) return `Skipped: ${flag}`;
  }
  if (!AI_CONFIG.apiToken) return "Skipped: CLOUDFLARE_API_TOKEN not set";
  if (!AI_CONFIG.accountId) return "Skipped: CLOUDFLARE_ACCOUNT_ID not set";
  if (!AI_CONFIG.gatewayId) return "Skipped: CLOUDFLARE_GATEWAY_ID not set";
  return false;
}

if (!AI_CONFIG.apiToken || !AI_CONFIG.accountId || !AI_CONFIG.gatewayId) {
  console.log(
    "[ai-runner] CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, or CLOUDFLARE_GATEWAY_ID not set — all tests will skip"
  );
}

const grouped = new Map<string, Scenario[]>();
for (const s of scenarios) {
  const key = `${s.category} / ${s.section}`;
  const list = grouped.get(key) ?? [];
  list.push(s);
  grouped.set(key, list);
}

for (const [group, items] of grouped) {
  test.describe(group, () => {
    for (const scenario of items) {
      test(`${scenario.title}`, async ({ page, context }) => {
        const skipReason = shouldSkip(scenario);
        if (skipReason) {
          test.skip(true, skipReason);
          return;
        }
        await executeScenario(scenario, page, context);
      });
    }
  });
}
