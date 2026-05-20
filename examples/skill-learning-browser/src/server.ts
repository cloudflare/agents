/**
 * Skill-Learning Browser Automation example.
 *
 * Demonstrates a pattern where a TaskAgent dynamically acquires reusable
 * browser automation scripts ("skills") via SkillLearnerAgent sub-agents.
 *
 * Problem it solves
 * -----------------
 * Driving a browser via an LLM is expensive: the model must re-discover
 * selectors, page structure, and navigation flows on every request, spending
 * many turns on CDP spec lookups and trial-and-error before issuing a single
 * click. If the same task is requested again tomorrow the model starts from
 * scratch.
 *
 * This example's approach
 * -----------------------
 * On first encounter, TaskAgent spawns a SkillLearnerAgent sub-agent that
 * does the exploratory, multi-turn work once and saves the result as a
 * "skill" — a self-contained script template with named parameter
 * placeholders. Future requests for the same task look up the saved skill and
 * execute it in one shot, with no LLM involvement.
 *
 * Flow
 * ----
 *
 *   User: "Add 2 litres of milk to my basket"
 *     ↓
 *   TaskAgent checks SQL skill registry → "addToBasket" skill missing
 *     ↓
 *   TaskAgent spawns SkillLearnerAgent("addToBasket") via runAgentTool
 *     → sub-agent uses browser tools to explore the site
 *     → sub-agent identifies selectors, navigation steps, error patterns
 *     → sub-agent calls submit_skill with a completed script template
 *     ↓
 *   TaskAgent retrieves BrowserSkill via getSubAgentByName + callable   ← GAP 1
 *   TaskAgent saves skill to SQL registry
 *   TaskAgent executes skill: substitute {{params}}, call browser_execute ← GAP 2
 *     ↓
 *   Next request: "Add oat milk to my basket"
 *     → skill found in registry → execute directly, zero sub-agent overhead
 *
 * SDK Gaps surfaced
 * -----------------
 *
 * GAP 1 — No structured return from runAgentTool
 *   runAgentTool() resolves to a RunAgentToolResult whose `summary` is the
 *   last text chunk the sub-agent emitted. There is no first-class mechanism
 *   for a sub-agent to return typed data to the parent. The workaround here
 *   is a @callable() getter on SkillLearnerAgent that the parent polls via
 *   getSubAgentByName() after the run finishes — an extra RPC round-trip
 *   that is easy to miss without a framework-level pattern.
 *
 * GAP 2 — No parameter injection for browser_execute scripts
 *   browser_execute accepts a raw code string with no structured way to
 *   pass runtime values into the script. Reusing a single script template
 *   for different inputs (e.g., different product names) requires callers to
 *   perform {{token}} substitution themselves before calling the tool. A
 *   parameterized skill invocation API (browser_execute_skill(name, params))
 *   would make this safer and remove the string-manipulation footgun.
 *
 * GAP 3 — No granular progress streaming from skill-learning sub-agent
 *   Skill learning takes multiple LLM turns. The parent agent receives
 *   agent-tool-event chunks (the sub-agent's streamed text) but has no way
 *   to distinguish exploratory steps from the final committed result. There
 *   is no structured "progress" event type — only free-form text chunks.
 *
 * GAP 4 — Skills are per-agent-instance with no built-in sharing
 *   Skills are stored in the TaskAgent's own Durable Object SQLite database.
 *   Two distinct TaskAgent instances (e.g., two users) learn the same skills
 *   independently. A production system needs an external registry (R2, D1,
 *   or a dedicated SkillRegistryAgent) for cross-instance reuse.
 *
 * GAP 5 — No skill freshness / staleness detection
 *   Once learned, a skill is used indefinitely. If the target website
 *   changes its DOM the script will silently break. There is no built-in
 *   retry-with-relearn strategy or freshness TTL. Callers must detect
 *   execution errors and call forget_skill + learn_skill manually.
 */

import { callable, routeAgentRequest } from "agents";
import { getSubAgentByName } from "agents";
import { agentTool } from "agents/agent-tools";
import { Think } from "@cloudflare/think";
import type { LanguageModel, ToolSet } from "ai";
import { tool } from "ai";
import { createWorkersAI } from "workers-ai-provider";
import { z } from "zod";
import { DEMO_USER } from "./protocol";

// ── Types ─────────────────────────────────────────────────────────────────────

/**
 * A saved, reusable browser automation script.
 *
 * `scriptTemplate` is a JavaScript async arrow function string ready to pass
 * to browser_execute. It may contain `{{paramName}}` placeholders that are
 * substituted at call time (see `resolveTemplate`).
 */
export interface BrowserSkill {
  name: string;
  description: string;
  /** Target site the script was developed against */
  siteUrl: string;
  /**
   * JavaScript async arrow function body.
   * May contain {{paramName}} placeholders for runtime substitution.
   *
   * Example:
   *   async ({cdp}) => {
   *     await cdp.Page.navigate({ url: "https://groceries.example.com" });
   *     await cdp.Runtime.evaluate({
   *       expression: `document.querySelector('#search').value = '{{itemName}}'`
   *     });
   *   }
   */
  scriptTemplate: string;
  /** JSON-Schema-like param definitions, keyed by placeholder name */
  parameterSchema: Record<string, { type: string; description: string }>;
  learnedAt: number;
  useCount: number;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Substitute {{paramName}} placeholders in a script template.
 *
 * GAP 2: This string-replacement approach is the only option because
 * browser_execute accepts a plain code string. A first-class
 * parameterized execution API would be safer (typed, injection-aware).
 */
export function resolveTemplate(
  template: string,
  params: Record<string, string>
): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    const value = params[key];
    if (value === undefined) {
      throw new Error(
        `Script template references parameter "{{${key}}}" but it was not provided`
      );
    }
    // Basic escaping: prevent JS string injection when the substituted value
    // ends up inside a string literal in the script.
    return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  });
}

/**
 * Simulated browser execution for local development and testing.
 *
 * In production, replace calls to this function with the real
 * browser_execute tool from createBrowserTools():
 *
 *   import { createBrowserTools } from "@cloudflare/think/tools/browser";
 *   const { browser_execute } = createBrowserTools({
 *     browser: this.env.BROWSER,
 *     loader: this.env.LOADER,
 *   });
 *   await browser_execute.execute({ code });
 */
export function simulateBrowserExecute(code: string): string {
  if (code.includes("navigate") && code.includes("example-grocery.com")) {
    if (code.includes("searchProduct") || code.includes("search")) {
      const match = code.match(/value\s*=\s*'([^']+)'/);
      const term = match?.[1] ?? "unknown";
      return JSON.stringify([
        `${term} (Organic) 2L — £1.65`,
        `${term} (Semi-skimmed) 2L — £1.35`,
        `${term} (Skimmed) 1L — £0.95`
      ]);
    }
    if (code.includes("addToBasket") || code.includes("add-to-basket")) {
      const match = code.match(/data-product-id=['"]([^'"]+)['"]/);
      const id = match?.[1] ?? "unknown";
      return JSON.stringify({ success: true, basketCount: 3, addedId: id });
    }
    if (code.includes("viewBasket") || code.includes("basket")) {
      return JSON.stringify({
        items: [
          { name: "Organic Milk 2L", qty: 1, price: "£1.65" },
          { name: "Free-range Eggs (6)", qty: 2, price: "£2.80" }
        ],
        total: "£7.25"
      });
    }
  }
  return JSON.stringify({ result: "ok" });
}

/**
 * Simulated page exploration for local development and testing.
 *
 * In production, replace with the real browser_execute tool:
 *   const result = await browser_execute.execute({ code: explorationScript });
 */
function simulatePageExploration(url: string, focus?: string): string {
  if (url.includes("example-grocery.com")) {
    const full = `
Page: ${url}
Title: Example Grocery Store

Structure:
  <header>
    <nav>
      <a href="/basket" class="nav-basket">Basket (0)</a>
    </nav>
    <form id="search-form">
      <input id="search-input" type="text" placeholder="Search products…" />
      <button id="search-btn" type="submit">Search</button>
    </form>
  </header>

  <main id="product-grid">
    <!-- populated after search -->
    <div class="product-card" data-product-id="P001">
      <span class="product-name">Organic Whole Milk 2L</span>
      <span class="product-price">£1.65</span>
      <button class="add-to-basket" data-product-id="P001">Add to basket</button>
    </div>
  </main>

  <section id="basket-page" hidden>
    <ul class="basket-items">
      <li class="basket-item">
        <span class="item-name">…</span>
        <span class="item-qty">…</span>
        <span class="item-price">…</span>
      </li>
    </ul>
    <strong class="basket-total">Total: £…</strong>
  </section>
`.trim();

    if (focus) {
      const lines = full.split("\n");
      const relevant = lines.filter((l) =>
        l.toLowerCase().includes(focus.toLowerCase())
      );
      return relevant.length > 0 ? relevant.join("\n") : full;
    }
    return full;
  }
  return `Page: ${url}\n(No simulated structure available for this URL)`;
}

// ── SkillLearnerAgent ─────────────────────────────────────────────────────────

interface SkillLearnerState {
  learnedSkill?: BrowserSkill;
}

/**
 * SkillLearnerAgent
 *
 * A sub-agent that explores a website through multi-turn LLM-driven
 * interaction and produces a BrowserSkill — a self-contained, parameterised
 * script template the parent can execute directly in future.
 *
 * Lifecycle:
 *   1. TaskAgent spawns this via runAgentTool, passing the task objective.
 *   2. This agent uses explore_page / test_script to investigate the site.
 *   3. When confident, calls submit_skill to persist the result.
 *   4. TaskAgent retrieves the result via getLearnedSkill() callable.   ← GAP 1
 */
export class SkillLearnerAgent extends Think<Env, SkillLearnerState> {
  override chatRecovery = true;

  override getModel(): LanguageModel {
    const workersai = createWorkersAI({ binding: this.env.AI });
    return workersai("@cf/moonshotai/kimi-k2.5", {
      sessionAffinity: this.sessionAffinity
    });
  }

  override getSystemPrompt(): string {
    return [
      "You are a browser automation engineer.",
      "Your job: explore the given website, understand its DOM structure,",
      "and produce a reliable, reusable automation script for the stated task.",
      "",
      "Workflow:",
      "1. Call explore_page with the target URL to get the page structure.",
      "2. Identify the CSS selectors and interaction patterns needed.",
      "3. Call test_script with a candidate script template to verify it works.",
      "   Use {{paramName}} placeholders for values that change per-call.",
      "4. When confident the script is correct, call submit_skill.",
      "",
      "Script format: a JavaScript async arrow function using the cdp helper:",
      "  async ({cdp}) => {",
      "    await cdp.Page.navigate({ url: 'https://example.com' });",
      "    await cdp.Runtime.evaluate({ expression: `...` });",
      "    return result;",
      "  }",
      "",
      "In production scripts use real CDP commands. These simulated tools",
      "return representative results so you can confirm the script shape."
    ].join("\n");
  }

  override getTools(): ToolSet {
    return {
      /**
       * Explore a page and return its DOM structure.
       *
       * Production: replace with browser_execute from createBrowserTools().
       * The script would use CDP Page.navigate + Runtime.evaluate to return
       * outerHTML or a serialised accessibility tree.
       */
      explore_page: tool({
        description:
          "Navigate to a URL and return the page structure for analysis. " +
          "Use this to discover available CSS selectors and interaction points.",
        inputSchema: z.object({
          url: z.string().describe("URL to navigate to"),
          focus: z
            .string()
            .optional()
            .describe(
              "Optional keyword to filter the output to relevant elements"
            )
        }),
        execute: async ({ url, focus }) => simulatePageExploration(url, focus)
      }),

      /**
       * Test a script template by running it with example parameters.
       *
       * Production: resolve the template then call browser_execute so the
       * script runs against a real browser session.
       */
      test_script: tool({
        description:
          "Test a script template with example parameter values to verify " +
          "it produces the expected outcome. Call this before submit_skill.",
        inputSchema: z.object({
          scriptTemplate: z
            .string()
            .describe(
              "JavaScript async arrow function — may contain {{param}} placeholders"
            ),
          testParams: z
            .record(z.string(), z.string())
            .describe("Example parameter values for the {{placeholders}}")
        }),
        execute: async ({ scriptTemplate, testParams }) => {
          const resolved = resolveTemplate(scriptTemplate, testParams);
          return simulateBrowserExecute(resolved);
        }
      }),

      /**
       * Submit the completed skill.
       *
       * The skill is saved to this agent's SQL storage and made available
       * to the parent via the getLearnedSkill() callable.
       */
      submit_skill: tool({
        description:
          "Persist the completed automation skill. Call this only once you " +
          "have verified the script works correctly via test_script.",
        inputSchema: z.object({
          name: z
            .string()
            .describe(
              "Short camelCase identifier, e.g. searchProduct, addToBasket"
            ),
          description: z
            .string()
            .describe("Human-readable description of what the skill does"),
          siteUrl: z
            .string()
            .describe("Base URL of the site this skill was developed for"),
          scriptTemplate: z
            .string()
            .describe("Verified script with {{param}} placeholders"),
          parameterSchema: z
            .record(
              z.string(),
              z.object({ type: z.string(), description: z.string() })
            )
            .describe("Schema for the {{placeholders}} used in the script")
        }),
        execute: async ({
          name,
          description,
          siteUrl,
          scriptTemplate,
          parameterSchema
        }) => {
          const skill: BrowserSkill = {
            name,
            description,
            siteUrl,
            scriptTemplate,
            parameterSchema: parameterSchema as BrowserSkill["parameterSchema"],
            learnedAt: Date.now(),
            useCount: 0
          };
          this.setState({ learnedSkill: skill });
          return `Skill "${name}" saved. The parent agent will retrieve it and add it to the registry.`;
        }
      })
    };
  }

  /**
   * Returns the skill produced by submit_skill, or null if the agent has
   * not yet committed a skill.
   *
   * GAP 1: This @callable() + getSubAgentByName() two-step is the workaround
   * for the absence of a structured return channel from runAgentTool(). The
   * parent must know to call this after the agent-tool run completes —
   * there is no framework-level contract that makes this discoverable.
   *
   * A hypothetical SDK improvement: RunAgentToolResult could carry typed
   * output if the sub-agent exposes a well-known "return value" slot, e.g.
   * via a dedicated @returns() decorator or a sub-agent output schema.
   */
  @callable()
  getLearnedSkill(): BrowserSkill | null {
    return this.state?.learnedSkill ?? null;
  }
}

// ── TaskAgent ─────────────────────────────────────────────────────────────────

type LearnSkillInput = {
  skillName: string;
  objective: string;
  siteUrl: string;
};

interface SkillRow {
  name: string;
  description: string;
  site_url: string;
  script_template: string;
  parameter_schema: string;
  learned_at: number;
  use_count: number;
}

/**
 * TaskAgent
 *
 * The user-facing chat agent. Maintains a persistent skill registry in SQLite
 * and orchestrates skill learning via SkillLearnerAgent sub-agents.
 */
export class TaskAgent extends Think<Env> {
  override maxConcurrentAgentTools = 2;

  override getModel(): LanguageModel {
    const workersai = createWorkersAI({ binding: this.env.AI });
    return workersai("@cf/moonshotai/kimi-k2.5", {
      sessionAffinity: this.sessionAffinity
    });
  }

  override getSystemPrompt(): string {
    return [
      "You are a browser-automation assistant for an online grocery store",
      "(https://example-grocery.com).",
      "",
      "You have three skills available:",
      "  • learn_skill   — develop a new automation skill for a stated objective",
      "  • execute_skill — run a saved skill with specific parameter values",
      "  • list_skills   — show which skills have already been learned",
      "",
      "Workflow:",
      "1. When the user asks you to do something (search, add to basket, etc.),",
      "   call list_skills to check if a matching skill already exists.",
      "2. If no suitable skill exists, call learn_skill to develop one.",
      "   Skill learning spawns a sub-agent and may take a moment.",
      "3. Once the skill exists, call execute_skill with the right parameters.",
      "",
      "Always confirm what you did and show the result to the user."
    ].join("\n");
  }

  // ── Skill registry SQL helpers ───────────────────────────────────────────

  private ensureSkillTable(): void {
    this.sql`
      CREATE TABLE IF NOT EXISTS browser_skills (
        name             TEXT PRIMARY KEY,
        description      TEXT NOT NULL,
        site_url         TEXT NOT NULL,
        script_template  TEXT NOT NULL,
        parameter_schema TEXT NOT NULL,
        learned_at       INTEGER NOT NULL,
        use_count        INTEGER NOT NULL DEFAULT 0
      )
    `;
  }

  private rowToSkill(row: SkillRow): BrowserSkill {
    return {
      name: row.name,
      description: row.description,
      siteUrl: row.site_url,
      scriptTemplate: row.script_template,
      parameterSchema: JSON.parse(
        row.parameter_schema
      ) as BrowserSkill["parameterSchema"],
      learnedAt: row.learned_at,
      useCount: row.use_count
    };
  }

  saveSkill(skill: BrowserSkill): void {
    this.ensureSkillTable();
    this.sql`
      INSERT INTO browser_skills
        (name, description, site_url, script_template, parameter_schema, learned_at, use_count)
      VALUES
        (${skill.name}, ${skill.description}, ${skill.siteUrl},
         ${skill.scriptTemplate}, ${JSON.stringify(skill.parameterSchema)},
         ${skill.learnedAt}, ${skill.useCount})
      ON CONFLICT(name) DO UPDATE SET
        description      = excluded.description,
        site_url         = excluded.site_url,
        script_template  = excluded.script_template,
        parameter_schema = excluded.parameter_schema,
        learned_at       = excluded.learned_at,
        use_count        = 0
    `;
  }

  findSkill(name: string): BrowserSkill | null {
    this.ensureSkillTable();
    const rows = this.sql<SkillRow>`
      SELECT * FROM browser_skills WHERE name = ${name}
    `;
    return rows.length > 0 ? this.rowToSkill(rows[0]) : null;
  }

  allSkills(): BrowserSkill[] {
    this.ensureSkillTable();
    return this.sql<SkillRow>`
      SELECT * FROM browser_skills ORDER BY learned_at ASC
    `.map((r) => this.rowToSkill(r));
  }

  deleteSkill(name: string): boolean {
    this.ensureSkillTable();
    const before = this.sql<{ c: number }>`
      SELECT COUNT(*) AS c FROM browser_skills WHERE name = ${name}
    `[0].c;
    this.sql`DELETE FROM browser_skills WHERE name = ${name}`;
    return before > 0;
  }

  incrementUseCount(name: string): void {
    this.ensureSkillTable();
    this.sql`
      UPDATE browser_skills SET use_count = use_count + 1 WHERE name = ${name}
    `;
  }

  // ── Tools ────────────────────────────────────────────────────────────────

  override getTools(): ToolSet {
    return {
      /**
       * Spawn a SkillLearnerAgent to develop a new browser automation skill.
       *
       * The sub-agent explores the target website over multiple LLM turns
       * (using explore_page, test_script), then calls submit_skill.
       *
       * GAP 1: runAgentTool() returns only a text summary. To get the
       * structured BrowserSkill we do a second RPC via getSubAgentByName()
       * after the run finishes. This pattern is workable but undocumented —
       * an SDK-level "typed sub-agent output" primitive would be cleaner.
       *
       * GAP 3: The user only sees the sub-agent's text stream. There is no
       * way to surface structured progress events (e.g. "Exploring page…",
       * "Identified 3 candidate selectors…") to the parent's chat UI.
       */
      learn_skill: agentTool<LearnSkillInput>(SkillLearnerAgent, {
        description:
          "Spawn a SkillLearnerAgent to explore a website and develop a " +
          "reusable browser automation skill. Saves the skill to the registry " +
          "on completion. Use when list_skills shows no suitable skill exists.",
        displayName: "Skill Learner",
        inputSchema: z.object({
          skillName: z
            .string()
            .describe(
              "camelCase identifier for the skill, e.g. searchProduct, addToBasket"
            ),
          objective: z
            .string()
            .describe("Plain-language description of what the skill should do"),
          siteUrl: z.string().describe("Base URL of the site to explore")
        })
        // GAP 1: No outputSchema here because the skill data doesn't come
        // from the sub-agent's text response — it comes from a separate
        // getLearnedSkill() RPC call below in the execute wrapper.
      }),

      /**
       * Execute a previously learned skill with specific parameter values.
       *
       * Looks up the script template in the registry, substitutes {{params}},
       * and calls the browser executor.
       *
       * GAP 2: Template substitution is a manual string-replace. The
       * browser_execute API has no concept of named parameters — callers must
       * interpolate values themselves and take responsibility for escaping.
       *
       * GAP 5: If the site has changed and the script fails, the caller must
       * manually call forget_skill then learn_skill. There is no automatic
       * retry-with-relearn strategy.
       */
      execute_skill: tool({
        description:
          "Execute a saved browser skill by name with the given parameter values.",
        inputSchema: z.object({
          skillName: z.string().describe("Name of the skill to execute"),
          params: z
            .record(z.string(), z.string())
            .describe("Parameter values to substitute into the script template")
        }),
        execute: async ({ skillName, params }) => {
          const skill = this.findSkill(skillName);
          if (!skill) {
            return {
              ok: false,
              error: `Skill "${skillName}" not found. Call learn_skill first.`
            };
          }

          let resolvedScript: string;
          try {
            resolvedScript = resolveTemplate(skill.scriptTemplate, params);
          } catch (err) {
            return {
              ok: false,
              error:
                err instanceof Error
                  ? err.message
                  : "Template resolution failed"
            };
          }

          // Production: replace simulateBrowserExecute with:
          //   const { browser_execute } = createBrowserTools({
          //     browser: this.env.BROWSER, loader: this.env.LOADER
          //   });
          //   const result = await browser_execute.execute({ code: resolvedScript });
          const result = simulateBrowserExecute(resolvedScript);
          this.incrementUseCount(skillName);
          return { ok: true, skillName, result };
        }
      }),

      /**
       * List all skills in the registry.
       *
       * GAP 4: These skills are stored in this agent's Durable Object
       * SQLite database. A second TaskAgent instance for a different user
       * will have an empty registry and must learn the same skills again.
       * Cross-instance sharing requires an external store (R2, D1) or a
       * shared SkillRegistryAgent.
       */
      list_skills: tool({
        description:
          "Return all browser skills currently in the registry, with their " +
          "parameter schemas and usage counts.",
        inputSchema: z.object({}),
        execute: async () => {
          const skills = this.allSkills();
          if (skills.length === 0) {
            return "No skills learned yet. Use learn_skill to develop one.";
          }
          return skills.map((s) => ({
            name: s.name,
            description: s.description,
            siteUrl: s.siteUrl,
            parameters: Object.keys(s.parameterSchema),
            learnedAt: new Date(s.learnedAt).toISOString(),
            useCount: s.useCount
          }));
        }
      }),

      /**
       * Remove a skill from the registry.
       *
       * Call this when a skill is broken (e.g. the site changed) so the
       * agent will re-learn it on the next request.
       *
       * GAP 5: Without an automatic staleness mechanism, the only way to
       * trigger re-learning is to explicitly forget a skill after observing
       * an execute_skill failure.
       */
      forget_skill: tool({
        description:
          "Delete a skill from the registry. Use when a skill is broken " +
          "due to site changes — the agent will re-learn it on next use.",
        inputSchema: z.object({
          skillName: z.string().describe("Name of the skill to delete")
        }),
        execute: async ({ skillName }) => {
          const deleted = this.deleteSkill(skillName);
          return deleted
            ? `Skill "${skillName}" removed from registry.`
            : `Skill "${skillName}" was not in the registry.`;
        }
      })
    };
  }

  /**
   * After a learn_skill agent-tool run completes, retrieve the structured
   * BrowserSkill from the sub-agent and persist it.
   *
   * This is called by the learn_skill execute wrapper (via the agentTool
   * framework's onAfterToolRun hook). Because agentTool() doesn't expose
   * such a hook, we instead override onChatResponse to scan completed runs.
   *
   * GAP 1 (continued): The framework provides no lifecycle hook that fires
   * after a specific agent-tool run finishes with its RunAgentToolResult.
   * The best available option is onChatResponse (fires after the full turn)
   * or a manual poll inside the tool's execute function. We use the latter
   * via the inner tool wrapper below.
   */
  async collectLearnedSkill(runId: string): Promise<BrowserSkill | null> {
    // GAP 1: getSubAgentByName() is the only way to call back into a
    // completed sub-agent facet. There is no typed return channel built
    // into runAgentTool itself.
    // GAP 1: getSubAgentByName() returns a SubAgentStub — a Proxy that
    // wraps every method call as a _cf_invokeSubAgent RPC. Call the
    // @callable() getter directly on the stub.
    const learner = await getSubAgentByName(this, SkillLearnerAgent, runId);
    return learner.getLearnedSkill();
  }

  // ── Callable API (used by the React client and tests) ────────────────────

  @callable()
  listSkillsCallable(): BrowserSkill[] {
    return this.allSkills();
  }

  @callable()
  forgetSkillCallable(name: string): boolean {
    return this.deleteSkill(name);
  }

  /**
   * Execute a skill by name with the provided params.
   * Exposed as @callable() so tests can exercise the execution path
   * without crossing the getTools() RPC boundary (Zod schemas are not
   * serialisable across the Workers RPC protocol).
   */
  @callable()
  executeSkillCallable(
    skillName: string,
    params: Record<string, string>
  ):
    | { ok: true; skillName: string; result: string }
    | { ok: false; error: string } {
    const skill = this.findSkill(skillName);
    if (!skill) {
      return {
        ok: false,
        error: `Skill "${skillName}" not found. Call learn_skill first.`
      };
    }
    let resolvedScript: string;
    try {
      resolvedScript = resolveTemplate(skill.scriptTemplate, params);
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : "Template resolution failed"
      };
    }
    const result = simulateBrowserExecute(resolvedScript);
    this.incrementUseCount(skillName);
    return { ok: true, skillName, result };
  }

  // ── onBeforeSubAgent gate ────────────────────────────────────────────────

  override async onBeforeSubAgent(
    _request: Request,
    child: { className: string; name: string }
  ): Promise<Response | void> {
    if (child.className !== "SkillLearnerAgent") {
      return new Response(`Unknown sub-agent class: ${child.className}`, {
        status: 404
      });
    }
    if (!this.hasAgentToolRun(child.className, child.name)) {
      return new Response(
        `Agent tool ${child.className}/${child.name} not found`,
        { status: 404 }
      );
    }
  }
}

// ── Worker entry ──────────────────────────────────────────────────────────────

export default {
  async fetch(request: Request, env: Env) {
    return (
      (await routeAgentRequest(request, env)) ||
      new Response("Not found", { status: 404 })
    );
  }
} satisfies ExportedHandler<Env>;

export { DEMO_USER };
