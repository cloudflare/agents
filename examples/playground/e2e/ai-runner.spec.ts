import { test } from "@playwright/test";
import { loadScenarios, type Scenario } from "./parse-testing-md";
import { executeScenario } from "./ai-executor";
import { AI_CONFIG, getApiUrl } from "./ai-config";

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

test.beforeAll(async () => {
  if (!AI_CONFIG.apiToken || !AI_CONFIG.accountId) {
    console.log(
      "[ai-runner] CLOUDFLARE_API_TOKEN or CLOUDFLARE_ACCOUNT_ID not set — all tests will skip"
    );
    return;
  }
  const url = getApiUrl();
  console.log(`[ai-runner] Health check: POST ${url}`);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${AI_CONFIG.apiToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        messages: [
          { role: "user", content: 'Reply with exactly: {"ok":true}' }
        ],
        max_tokens: 32,
        temperature: 0
      })
    });
    const body = await res.text();
    console.log(
      `[ai-runner] Health check response ${res.status}: ${body.slice(0, 500)}`
    );
    if (!res.ok) {
      throw new Error(
        `Workers AI health check failed: ${res.status} ${body.slice(0, 300)}`
      );
    }
  } catch (err) {
    console.error("[ai-runner] Health check error:", err);
    throw err;
  }
});

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
