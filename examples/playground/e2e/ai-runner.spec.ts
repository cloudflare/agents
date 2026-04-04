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
  return false;
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
      const skipReason = shouldSkip(scenario);

      const testFn = skipReason ? test.skip : test;

      testFn(`${scenario.title}`, async ({ page, context }) => {
        await executeScenario(scenario, page, context);
      });
    }
  });
}
