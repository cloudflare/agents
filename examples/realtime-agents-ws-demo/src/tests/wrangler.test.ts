import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Strip JSONC comments (// and /* */) to parse as JSON
function parseJsonc(text: string): unknown {
  const stripped = text
    .replace(/\/\/.*$/gm, "")
    .replace(/\/\*[\s\S]*?\*\//g, "");
  return JSON.parse(stripped);
}

describe("wrangler.jsonc configuration", () => {
  let config: Record<string, unknown>;

  beforeAll(() => {
    const raw = readFileSync(
      resolve(__dirname, "../../wrangler.jsonc"),
      "utf-8"
    );
    config = parseJsonc(raw) as Record<string, unknown>;
  });

  // ── Durable Objects ──────────────────────────────────────────────────

  describe("durable_objects", () => {
    it("should have durable_objects section", () => {
      expect(config).toHaveProperty("durable_objects");
    });

    it("should have bindings array", () => {
      const doConfig = config.durable_objects as Record<string, unknown>;
      expect(doConfig).toHaveProperty("bindings");
      expect(Array.isArray(doConfig.bindings)).toBe(true);
    });

    it("should have VoiceAgent binding with correct class_name", () => {
      const doConfig = config.durable_objects as {
        bindings: Array<Record<string, string>>;
      };
      const voiceAgentBinding = doConfig.bindings.find(
        (b) => b.class_name === "VoiceAgent"
      );
      expect(voiceAgentBinding).toBeDefined();
      expect(voiceAgentBinding!.name).toBe("VoiceAgent");
    });

    it("should not have any bindings without class_name", () => {
      const doConfig = config.durable_objects as {
        bindings: Array<Record<string, string>>;
      };
      for (const binding of doConfig.bindings) {
        expect(binding.class_name).toBeTruthy();
        expect(binding.name).toBeTruthy();
      }
    });

    it("should not have stale ChatAgent binding", () => {
      const doConfig = config.durable_objects as {
        bindings: Array<Record<string, string>>;
      };
      const chatAgentBinding = doConfig.bindings.find(
        (b) => b.class_name === "ChatAgent"
      );
      expect(chatAgentBinding).toBeUndefined();
    });
  });

  // ── Migrations ───────────────────────────────────────────────────────

  describe("migrations", () => {
    it("should have migrations array", () => {
      expect(config).toHaveProperty("migrations");
      expect(Array.isArray(config.migrations)).toBe(true);
    });

    it("should have at least one migration", () => {
      const migrations = config.migrations as Array<Record<string, unknown>>;
      expect(migrations.length).toBeGreaterThanOrEqual(1);
    });

    it("should have a migration with new_sqlite_classes including VoiceAgent", () => {
      const migrations = config.migrations as Array<Record<string, unknown>>;
      const sqliteMigration = migrations.find(
        (m) =>
          Array.isArray(m.new_sqlite_classes) &&
          (m.new_sqlite_classes as string[]).includes("VoiceAgent")
      );
      expect(sqliteMigration).toBeDefined();
    });

    it("each migration should have a tag", () => {
      const migrations = config.migrations as Array<Record<string, unknown>>;
      for (const migration of migrations) {
        expect(migration.tag).toBeTruthy();
      }
    });
  });

  // ── AI Binding ───────────────────────────────────────────────────────

  describe("ai binding", () => {
    it("should have ai section", () => {
      expect(config).toHaveProperty("ai");
    });

    it("should have AI binding name", () => {
      const ai = config.ai as Record<string, unknown>;
      expect(ai.binding).toBe("AI");
    });

    it("should have remote set to true for dev", () => {
      const ai = config.ai as Record<string, unknown>;
      expect(ai.remote).toBe(true);
    });
  });

  // ── Assets / SPA ─────────────────────────────────────────────────────

  describe("assets configuration", () => {
    it("should have assets section", () => {
      expect(config).toHaveProperty("assets");
    });

    it("should use single-page-application not_found_handling", () => {
      const assets = config.assets as Record<string, unknown>;
      expect(assets.not_found_handling).toBe("single-page-application");
    });

    it("should route /agents/* to worker first", () => {
      const assets = config.assets as Record<string, unknown>;
      expect(assets.run_worker_first).toEqual(
        expect.arrayContaining(["/agents/*"])
      );
    });
  });

  // ── General ──────────────────────────────────────────────────────────

  describe("general settings", () => {
    it("should have a name", () => {
      expect(config.name).toBeTruthy();
    });

    it("should have main pointing to server.ts", () => {
      expect(config.main).toMatch(/server\.ts$/);
    });

    it("should have compatibility_date set", () => {
      expect(config.compatibility_date).toBeTruthy();
      expect(new Date(config.compatibility_date as string).toString()).not.toBe(
        "Invalid Date"
      );
    });

    it("should have nodejs_compat flag", () => {
      const flags = config.compatibility_flags as string[];
      expect(flags).toContain("nodejs_compat");
    });

    it("should have observability enabled", () => {
      const obs = config.observability as Record<string, unknown>;
      expect(obs?.enabled).toBe(true);
    });
  });

  // ── Consistency: DO class names match between bindings and migrations ──

  describe("consistency checks", () => {
    it("every DO binding class should have a corresponding sqlite migration", () => {
      const doConfig = config.durable_objects as {
        bindings: Array<Record<string, string>>;
      };
      const migrations = config.migrations as Array<Record<string, unknown>>;

      const migratedClasses = new Set<string>();
      for (const m of migrations) {
        if (Array.isArray(m.new_sqlite_classes)) {
          for (const cls of m.new_sqlite_classes as string[]) {
            migratedClasses.add(cls);
          }
        }
      }

      for (const binding of doConfig.bindings) {
        expect(
          migratedClasses.has(binding.class_name),
          `DO binding "${binding.class_name}" should have a sqlite migration`
        ).toBe(true);
      }
    });
  });
});
