import { test } from "@playwright/test";
import { loadScenarios, type Scenario } from "./parse-testing-md";
import { executeScenario } from "./ai-executor";
import { AI_CONFIG } from "./ai-config";

const scenarios = loadScenarios();

const SKIP_FLAGS = new Set(["deployed-only"]);

function shouldSkip(scenario: Scenario): string | false {
  for (const flag of scenario.flags) {
    if (SKIP_FLAGS.has(flag)) return `Skipped: ${flag}`;
  }
  if (!AI_CONFIG.apiToken) return "Skipped: CLOUDFLARE_API_TOKEN not set";
  if (!AI_CONFIG.accountId) return "Skipped: CLOUDFLARE_ACCOUNT_ID not set";
  return false;
}

if (!AI_CONFIG.apiToken || !AI_CONFIG.accountId) {
  console.log(
    "[ai-runner] CLOUDFLARE_API_TOKEN or CLOUDFLARE_ACCOUNT_ID not set — all tests will skip"
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
