/**
 * Tests for the skill-learning browser automation example.
 *
 * Tests are organised into four groups:
 *
 * 1. Skill registry   — CRUD operations on the SQL skill store
 * 2. Template resolution — {{param}} substitution as pure functions
 * 3. Skill execution  — end-to-end via @callable() helpers
 * 4. Sub-agent gate   — onBeforeSubAgent access control
 *
 * All tests bypass the LLM path. No AI binding is declared in the test
 * wrangler.jsonc; agents are manipulated via @callable() methods and
 * test helpers rather than the WebSocket chat protocol.
 *
 * Note: all calls on a DO RPC stub are async (they cross a process
 * boundary), so every agent method call is awaited even when the
 * underlying implementation is synchronous.
 */

import { env, exports } from "cloudflare:workers";
import { getAgentByName } from "agents";
import { describe, expect, it } from "vitest";
import { resolveTemplate, simulateBrowserExecute } from "../server";
import type { TaskAgent } from "./worker";
import type { BrowserSkill } from "../server";

type TestEnv = typeof env & {
  TaskAgent: DurableObjectNamespace<TaskAgent>;
};

// ── Fixtures ──────────────────────────────────────────────────────────────────

function uniqueAgentName(): string {
  return `skill-test-${crypto.randomUUID()}`;
}

async function getTaskAgent(name: string): Promise<TaskAgent> {
  return (await getAgentByName(
    (env as TestEnv).TaskAgent,
    name
  )) as unknown as TaskAgent;
}

function makeSkill(overrides: Partial<BrowserSkill> = {}): BrowserSkill {
  return {
    name: "searchProduct",
    description: "Search for a product by name on the grocery store",
    siteUrl: "https://example-grocery.com",
    scriptTemplate: [
      "async ({cdp}) => {",
      "  await cdp.Page.navigate({ url: 'https://example-grocery.com' });",
      "  await cdp.Runtime.evaluate({",
      "    expression: `document.querySelector('#search-input').value = '{{itemName}}'`",
      "  });",
      "  return await cdp.Runtime.evaluate({",
      "    expression: 'JSON.stringify([...document.querySelectorAll(\".product-name\")].map(e => e.textContent))'",
      "  });",
      "}"
    ].join("\n"),
    parameterSchema: {
      itemName: { type: "string", description: "Product name to search for" }
    },
    learnedAt: Date.now(),
    useCount: 0,
    ...overrides
  };
}

// ── 1. Skill registry (via @callable helpers) ─────────────────────────────────

describe("skill registry", () => {
  it("starts empty", async () => {
    const agent = await getTaskAgent(uniqueAgentName());
    expect(await agent.listSkillsCallable()).toEqual([]);
  });

  it("saves and retrieves a skill", async () => {
    const agent = await getTaskAgent(uniqueAgentName());
    const skill = makeSkill();
    await agent.testSeedSkill(skill);

    const all = await agent.listSkillsCallable();
    expect(all).toHaveLength(1);
    expect(all[0].name).toBe("searchProduct");
    expect(all[0].siteUrl).toBe("https://example-grocery.com");
    expect(all[0].parameterSchema).toEqual({
      itemName: { type: "string", description: "Product name to search for" }
    });
  });

  it("overwrites an existing skill on re-seed (simulating re-learning)", async () => {
    const agent = await getTaskAgent(uniqueAgentName());
    await agent.testSeedSkill(makeSkill({ description: "original" }));
    await agent.testSeedSkill(makeSkill({ description: "updated" }));

    const all = await agent.listSkillsCallable();
    expect(all).toHaveLength(1);
    expect(all[0].description).toBe("updated");
  });

  it("resets use_count to zero when a skill is re-learned", async () => {
    const agent = await getTaskAgent(uniqueAgentName());
    await agent.testSeedSkill(makeSkill({ useCount: 99 }));
    await agent.testSeedSkill(
      makeSkill({ useCount: 0, description: "re-learned" })
    );

    const all = await agent.listSkillsCallable();
    expect(all[0].useCount).toBe(0);
  });

  it("lists skills in insertion order", async () => {
    const agent = await getTaskAgent(uniqueAgentName());
    const t0 = Date.now();
    await agent.testSeedSkill(
      makeSkill({ name: "searchProduct", learnedAt: t0 })
    );
    await agent.testSeedSkill(
      makeSkill({ name: "addToBasket", learnedAt: t0 + 1000 })
    );
    await agent.testSeedSkill(
      makeSkill({ name: "viewBasket", learnedAt: t0 + 2000 })
    );

    const names = (await agent.listSkillsCallable()).map((s) => s.name);
    expect(names).toEqual(["searchProduct", "addToBasket", "viewBasket"]);
  });

  it("deletes a skill via forgetSkillCallable", async () => {
    const agent = await getTaskAgent(uniqueAgentName());
    await agent.testSeedSkill(makeSkill());

    const ok = await agent.forgetSkillCallable("searchProduct");
    expect(ok).toBe(true);
    expect(await agent.listSkillsCallable()).toHaveLength(0);
  });

  it("returns false when forgetting a non-existent skill", async () => {
    const agent = await getTaskAgent(uniqueAgentName());
    expect(await agent.forgetSkillCallable("nonExistent")).toBe(false);
  });
});

// ── 2. Template resolution (pure function — no RPC) ────────────────────────────
//
// resolveTemplate is exported so we can test it directly without crossing
// the Workers RPC boundary (which would require serialising Zod schemas if
// we called it via the agent stub — see GAP note in server.ts).

describe("template resolution (GAP 2: no SDK-level param injection)", () => {
  it("substitutes a single placeholder", () => {
    const result = resolveTemplate("search('{{itemName}}')", {
      itemName: "milk"
    });
    expect(result).toBe("search('milk')");
  });

  it("substitutes multiple distinct placeholders", () => {
    const result = resolveTemplate("{{action}}('{{item}}', {{qty}})", {
      action: "add",
      item: "eggs",
      qty: "2"
    });
    expect(result).toBe("add('eggs', 2)");
  });

  it("substitutes the same placeholder multiple times", () => {
    const result = resolveTemplate("{{x}} + {{x}}", { x: "5" });
    expect(result).toBe("5 + 5");
  });

  it("escapes single quotes in substituted values", () => {
    const result = resolveTemplate("'{{name}}'", { name: "farmer's milk" });
    // The substituted value should have its single quote escaped so the
    // surrounding JS string literal remains valid.
    expect(result).toBe("'farmer\\'s milk'");
    // Verify no raw unescaped single quote remains that would break a JS string
    expect(result.indexOf("farmer's")).toBe(-1);
  });

  it("escapes backslashes in substituted values", () => {
    const result = resolveTemplate("'{{path}}'", {
      path: "C:\\Users\\Alice"
    });
    expect(result).toBe("'C:\\\\Users\\\\Alice'");
  });

  it("throws when a required placeholder is missing", () => {
    expect(() => resolveTemplate("'{{itemName}}'", {})).toThrow(
      'parameter "{{itemName}}"'
    );
  });

  it("leaves unrelated text untouched", () => {
    const script = "async ({cdp}) => { return 42; }";
    expect(resolveTemplate(script, {})).toBe(script);
  });
});

// ── 3. Simulated browser execution (pure function — no RPC) ──────────────────

describe("simulateBrowserExecute", () => {
  it("returns search results for a search script", () => {
    const code = [
      "async ({cdp}) => {",
      "  await cdp.Page.navigate({ url: 'https://example-grocery.com' });",
      "  document.querySelector('#search-input').value = 'milk';",
      "  return search();",
      "}"
    ].join("\n");
    const result = JSON.parse(simulateBrowserExecute(code)) as string[];
    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBeGreaterThan(0);
    expect(result[0]).toContain("milk");
  });

  it("returns a basket result for an add-to-basket script", () => {
    const code = [
      "async ({cdp}) => {",
      "  await cdp.Page.navigate({ url: 'https://example-grocery.com' });",
      "  document.querySelector('.add-to-basket').click();",
      "  return addToBasket();",
      "}"
    ].join("\n");
    const result = JSON.parse(simulateBrowserExecute(code)) as {
      success: boolean;
    };
    expect(result.success).toBe(true);
  });

  it("returns basket contents for a viewBasket script", () => {
    const code = [
      "async ({cdp}) => {",
      "  await cdp.Page.navigate({ url: 'https://example-grocery.com' });",
      "  return viewBasket();",
      "}"
    ].join("\n");
    const result = JSON.parse(simulateBrowserExecute(code)) as {
      items: unknown[];
      total: string;
    };
    expect(Array.isArray(result.items)).toBe(true);
    expect(typeof result.total).toBe("string");
  });
});

// ── 4. Skill execution via @callable() (end-to-end without LLM) ──────────────

describe("executeSkillCallable", () => {
  it("returns an error when the skill is not in the registry", async () => {
    const agent = await getTaskAgent(uniqueAgentName());
    const result = await agent.executeSkillCallable("missingSkill", {});
    expect(result).toMatchObject({ ok: false });
    expect((result as { error: string }).error).toContain("missingSkill");
  });

  it("executes a saved skill and returns a result", async () => {
    const agent = await getTaskAgent(uniqueAgentName());
    await agent.testSeedSkill(
      makeSkill({
        name: "searchProduct",
        scriptTemplate: [
          "async ({cdp}) => {",
          "  await cdp.Page.navigate({ url: 'https://example-grocery.com' });",
          "  document.querySelector('#search-input').value = '{{itemName}}';",
          "  return search();",
          "}"
        ].join("\n")
      })
    );

    const result = await agent.executeSkillCallable("searchProduct", {
      itemName: "milk"
    });
    expect(result).toMatchObject({ ok: true, skillName: "searchProduct" });
  });

  it("increments use_count after successful execution", async () => {
    const agent = await getTaskAgent(uniqueAgentName());
    // Use a template with no placeholders so execution always succeeds
    await agent.testSeedSkill(
      makeSkill({
        name: "viewBasket",
        parameterSchema: {},
        scriptTemplate: [
          "async ({cdp}) => {",
          "  await cdp.Page.navigate({ url: 'https://example-grocery.com' });",
          "  return viewBasket();",
          "}"
        ].join("\n")
      })
    );

    await agent.executeSkillCallable("viewBasket", {});
    await agent.executeSkillCallable("viewBasket", {});

    const skills = await agent.listSkillsCallable();
    const skill = skills.find((s) => s.name === "viewBasket");
    expect(skill?.useCount).toBe(2);
  });

  it("returns error when a required template param is missing", async () => {
    const agent = await getTaskAgent(uniqueAgentName());
    await agent.testSeedSkill(makeSkill({ name: "searchProduct" }));

    // Missing "itemName" → resolveTemplate should throw
    const result = await agent.executeSkillCallable("searchProduct", {});
    expect(result).toMatchObject({ ok: false });
    expect((result as { error: string }).error).toContain("itemName");
  });
});

// ── 5. Sub-agent gate ─────────────────────────────────────────────────────────

describe("onBeforeSubAgent gate", () => {
  it("returns 404 for an unknown sub-agent class", async () => {
    const name = uniqueAgentName();
    // partyserver converts binding keys to kebab-case for URL routing:
    // "TaskAgent" → "task-agent"
    const response = await exports.default.fetch(
      `http://example.com/agents/task-agent/${name}/sub/UnknownClass/run-1`
    );
    expect(response.status).toBe(404);
  });

  it("returns 404 when SkillLearnerAgent run is not in the registry", async () => {
    const name = uniqueAgentName();
    const response = await exports.default.fetch(
      `http://example.com/agents/task-agent/${name}/sub/SkillLearnerAgent/not-a-real-run`
    );
    expect(response.status).toBe(404);
  });

  it("allows drill-in to a registered SkillLearnerAgent run", async () => {
    const name = uniqueAgentName();
    const agent = await getTaskAgent(name);
    await agent.testSeedAgentToolRun({
      runId: "test-run-1",
      agentType: "SkillLearnerAgent",
      inputPreview: "learn searchProduct"
    });

    expect(
      await agent.testHasAgentToolRun("SkillLearnerAgent", "test-run-1")
    ).toBe(true);
  });
});
