import { describe, expect, it } from "vitest";
import { Think } from "../think";

type StoredRow = { code: string; created_at: number };

function createFakeSql() {
  const rows = new Map<string, StoredRow>();
  const sql = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join("?");
    if (text.includes("INSERT INTO cf_think_dynamic_workflows")) {
      const [wfId, code, createdAt] = values as [string, string, number];
      rows.set(wfId, { code, created_at: createdAt });
      return [];
    }
    if (text.includes("DELETE FROM cf_think_dynamic_workflows")) {
      const wfId = values[0] as string;
      rows.delete(wfId);
      return [];
    }
    if (text.includes("SELECT code FROM cf_think_dynamic_workflows")) {
      const wfId = values[0] as string;
      const row = rows.get(wfId);
      return row ? [{ code: row.code }] : [];
    }
    // CREATE TABLE, tracking INSERT into cf_agents_workflows, getWorkflow
    // SELECT (no tracked rows in these unit tests), etc.
    return [];
  };
  return { sql, rows };
}

type CreatedWorkflow = { id: string; params: Record<string, unknown> };

interface TestThink {
  env: Record<string, unknown>;
  name: string;
  runDynamicWorkflow(
    workflowName: string,
    code: string,
    params?: Record<string, unknown>,
    options?: {
      id?: string;
      agentBinding?: string;
      metadata?: Record<string, unknown>;
    }
  ): Promise<string>;
  _getWorkflowCode(wfId: string): Promise<string>;
  validateWorkflowCode(code: string): void;
  _findAgentBindingNameForDynamic(): string | undefined;
}

function createFakeAgent(overrides?: {
  agentBindingKey?: string;
  includeWorkflow?: boolean;
  failCreate?: boolean;
}) {
  const created: CreatedWorkflow[] = [];
  const { sql, rows } = createFakeSql();
  // The fake instance's runtime class is `Think`, so the binding name must
  // match "Think" (or its kebab form) for auto-detection to succeed.
  const agentBindingKey = overrides?.agentBindingKey ?? "Think";
  const env: Record<string, unknown> = {
    [agentBindingKey]: {
      idFromName: (name: string) => ({ name }),
      get: () => ({})
    }
  };
  if (overrides?.includeWorkflow !== false) {
    env.DYNAMIC_THINK_WF = {
      create: async (opts: CreatedWorkflow) => {
        if (overrides?.failCreate) {
          throw new Error("create failed");
        }
        created.push(opts);
        return { id: opts.id };
      }
    };
  }
  const agent = Object.assign(Object.create(Think.prototype), {
    env,
    sql
  }) as unknown as TestThink;
  // `name` is a getter-only accessor on the partyserver base class, so define
  // an own data property to shadow it instead of assigning through it.
  Object.defineProperty(agent, "name", {
    value: "instance-1",
    configurable: true
  });
  return { agent, created, rows, env };
}

describe("Think dynamic workflows", () => {
  describe("validateWorkflowCode", () => {
    it("rejects empty code", () => {
      const { agent } = createFakeAgent();
      expect(() => agent.validateWorkflowCode("   ")).toThrow(/non-empty/);
    });

    it("rejects code over the size limit", () => {
      const { agent } = createFakeAgent();
      const tooBig = "x".repeat(Think.MAX_DYNAMIC_WORKFLOW_CODE_BYTES + 1);
      expect(() => agent.validateWorkflowCode(tooBig)).toThrow(/too large/);
    });

    it("rejects code without a GeneratedWorkflow class", () => {
      const { agent } = createFakeAgent();
      expect(() =>
        agent.validateWorkflowCode("export default class Other {}")
      ).toThrow(/GeneratedWorkflow/);
    });

    it("accepts reasonable code", () => {
      const { agent } = createFakeAgent();
      expect(() =>
        agent.validateWorkflowCode("export default class GeneratedWorkflow {}")
      ).not.toThrow();
    });
  });

  describe("_findAgentBindingNameForDynamic", () => {
    it("detects the agent binding and caches the result", () => {
      const { agent, env } = createFakeAgent();
      expect(agent._findAgentBindingNameForDynamic()).toBe("Think");
      // Caching: clearing env must not change the resolved value.
      delete env.Think;
      expect(agent._findAgentBindingNameForDynamic()).toBe("Think");
    });
  });

  describe("runDynamicWorkflow", () => {
    it("stores retrievable code and dispatches the workflow with the expected envelope", async () => {
      const { agent, created } = createFakeAgent();
      const code =
        "export default class GeneratedWorkflow extends ThinkWorkflow {}";

      const workflowId = await agent.runDynamicWorkflow(
        "DYNAMIC_THINK_WF",
        code,
        { topic: "hello" }
      );

      expect(created).toHaveLength(1);
      expect(created[0].id).toBe(workflowId);

      const envelope = created[0].params as {
        __dispatcherMetadata: {
          wfId: string;
          agentBinding: string;
          agentName: string;
        };
        params: Record<string, unknown>;
      };
      expect(envelope.__dispatcherMetadata.agentBinding).toBe("Think");
      expect(envelope.__dispatcherMetadata.agentName).toBe("instance-1");
      expect(envelope.params).toMatchObject({
        topic: "hello",
        __agentName: "instance-1",
        __agentBinding: "Think",
        __workflowName: "DYNAMIC_THINK_WF"
      });

      // The stored code is retrievable via the loader RPC method.
      const stored = await agent._getWorkflowCode(
        envelope.__dispatcherMetadata.wfId
      );
      expect(stored).toBe(code);
    });

    it("throws when the workflow binding is missing", async () => {
      const { agent } = createFakeAgent({ includeWorkflow: false });
      await expect(
        agent.runDynamicWorkflow(
          "DYNAMIC_THINK_WF",
          "export default class GeneratedWorkflow {}"
        )
      ).rejects.toThrow(/not found in environment/);
    });

    it("throws when the agent binding is not a Durable Object namespace", async () => {
      const { agent, env } = createFakeAgent();
      env.NOT_A_DO = "just a string";
      await expect(
        agent.runDynamicWorkflow(
          "DYNAMIC_THINK_WF",
          "export default class GeneratedWorkflow {}",
          {},
          { agentBinding: "NOT_A_DO" }
        )
      ).rejects.toThrow(/not a Durable Object namespace/);
    });

    it("removes the stored code row when workflow.create fails", async () => {
      const { agent, rows } = createFakeAgent({ failCreate: true });
      await expect(
        agent.runDynamicWorkflow(
          "DYNAMIC_THINK_WF",
          "export default class GeneratedWorkflow {}"
        )
      ).rejects.toThrow(/create failed/);
      // The orphaned code row must have been cleaned up.
      expect(rows.size).toBe(0);
    });
  });
});
