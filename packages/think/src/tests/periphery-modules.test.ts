import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import type { LanguageModel, ToolSet } from "ai";
import { describe, expect, it } from "vitest";
import { ThinkModelResolver, isWorkersAIModelId } from "../model";
import { capabilityBlock, systemPromptForTurn } from "../system-prompt";

type ConfigAccess = {
  _configGet(key: string): string | undefined;
  _configSet(key: string, value: string): void;
  _configDelete(key: string): void;
  _migrateLegacyConfigToThinkTable(): void;
};

/** A started Think agent's config store and the SQLite it writes. */
async function withConfig<T>(
  fn: (config: ConfigAccess, sql: SqlStorage) => T | Promise<T>
) {
  const stub = env.BareAssistantAgent.get(
    env.BareAssistantAgent.idFromName(`periphery-${crypto.randomUUID()}`)
  );
  await stub.fetch("http://x/");
  return runInDurableObject(stub, (instance, state) =>
    fn(instance as unknown as ConfigAccess, state.storage.sql)
  );
}

function thinkConfigValue(sql: SqlStorage, key: string): string | undefined {
  return sql
    .exec<{ value: string }>(
      "SELECT value FROM think_config WHERE key = ?",
      key
    )
    .toArray()[0]?.value;
}

describe("ThinkConfigStore", () => {
  it("stores, reads and deletes keys", async () => {
    await withConfig((config, sql) => {
      expect(config._configGet("a")).toBeUndefined();
      config._configSet("a", "1");
      expect(config._configGet("a")).toBe("1");
      expect(thinkConfigValue(sql, "a")).toBe("1");
      config._configDelete("a");
      expect(config._configGet("a")).toBeUndefined();
    });
  });

  it("skips a write whose value matches the last value it saw", async () => {
    await withConfig((config, sql) => {
      config._configSet("a", "1");
      sql.exec("UPDATE think_config SET value = 'other' WHERE key = 'a'");
      config._configSet("a", "1");
      expect(thinkConfigValue(sql, "a")).toBe("other");
      config._configSet("a", "2");
      expect(thinkConfigValue(sql, "a")).toBe("2");
    });
  });

  it("lifts Think's keys out of assistant_config and drops it", async () => {
    await withConfig((config, sql) => {
      sql.exec(`CREATE TABLE assistant_config (
        session_id TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL,
        PRIMARY KEY (session_id, key))`);
      sql.exec(
        "INSERT INTO assistant_config VALUES ('', 'lastBody', '{\"x\":1}'), ('', 'unrelated', 'y'), ('s1', 'skillsFingerprint', 'other-session')"
      );
      config._migrateLegacyConfigToThinkTable();
      expect(config._configGet("lastBody")).toBe('{"x":1}');
      expect(config._configGet("unrelated")).toBeUndefined();
      expect(config._configGet("skillsFingerprint")).toBeUndefined();
      const tables = sql
        .exec<{ name: string }>(
          "SELECT name FROM sqlite_master WHERE name = 'assistant_config'"
        )
        .toArray();
      expect(tables).toEqual([]);
    });
  });

  it("keeps a think_config value over the legacy one", async () => {
    await withConfig((config, sql) => {
      config._configSet("lastBody", "current");
      sql.exec(`CREATE TABLE assistant_config__lifted_v1 (
        session_id TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL)`);
      sql.exec(
        "INSERT INTO assistant_config__lifted_v1 VALUES ('', 'lastBody', 'legacy')"
      );
      config._migrateLegacyConfigToThinkTable();
      expect(config._configGet("lastBody")).toBe("current");
    });
  });
});

describe("ThinkModelResolver", () => {
  const fakeAi = { run: async () => ({}) } as unknown as Ai;

  function resolver(gateway?: (model: string) => GatewayOptions | undefined) {
    let bindingReads = 0;
    const models = new ThinkModelResolver({
      binding: () => {
        bindingReads++;
        return fakeAi;
      },
      gateway: gateway ?? (() => undefined),
      sessionAffinity: () => "affinity"
    });
    return { models, bindingReads: () => bindingReads };
  }

  it("recognises Workers AI ids", () => {
    expect(isWorkersAIModelId("@cf/meta/llama")).toBe(true);
    expect(isWorkersAIModelId("@hf/thebloke/x")).toBe(true);
    expect(isWorkersAIModelId("@cf/")).toBe(false);
    expect(isWorkersAIModelId("openai/gpt-5.5")).toBe(false);
  });

  it("returns a LanguageModel as-is without reading the binding", () => {
    const { models, bindingReads } = resolver();
    const model = { modelId: "mine" } as unknown as LanguageModel;
    expect(models.resolve(model)).toBe(model);
    expect(bindingReads()).toBe(0);
  });

  it("builds string models through one provider", () => {
    const { models, bindingReads } = resolver();
    const workersAI = models.resolve("@cf/meta/llama") as { modelId: string };
    const gateway = models.resolve("openai/gpt-5.5") as { modelId: string };
    expect(workersAI.modelId).toBe("@cf/meta/llama");
    expect(gateway.modelId).toBe("gpt-5.5");
    expect(bindingReads()).toBe(1);
  });

  it("rejects malformed ids", () => {
    const { models } = resolver();
    for (const id of ["@bad", "noslash", "/model", "provider/"]) {
      expect(() => models.resolve(id)).toThrow(/Invalid model id/);
    }
  });

  it("rejects a getGateway that returns a Promise", () => {
    const { models } = resolver(
      () => Promise.resolve({ id: "g" }) as unknown as GatewayOptions
    );
    expect(() => models.resolve("openai/gpt-5.5")).toThrow(
      /returned a Promise/
    );
  });
});

describe("systemPromptForTurn", () => {
  const noop = { execute: async () => null } as unknown as ToolSet[string];

  it("appends a capability line per kind of tool", () => {
    const prompt = systemPromptForTurn("Base.  ", {
      read: noop,
      execute: noop,
      fetch_docs: noop,
      load_extension: noop
    });
    expect(
      prompt.startsWith("Base.\n\nYou are running inside a Think agent.")
    ).toBe(true);
    expect(prompt).toContain("agent workspace");
    expect(prompt).toContain("sandboxed execution");
    expect(prompt).toContain("fetch tools");
    expect(prompt).toContain("extension tools");
  });

  it("lists no tool lines for a turn without tools", () => {
    const block = capabilityBlock({});
    expect(block).not.toContain("Use the tools exposed");
    expect(block).toContain("Do not claim access");
  });

  it("leaves a prompt that already has the block alone", () => {
    const base = `Base.\n\n${capabilityBlock({})}`;
    expect(systemPromptForTurn(base, { read: noop })).toBe(base);
  });
});
