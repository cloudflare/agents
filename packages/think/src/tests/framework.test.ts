import { describe, expect, it } from "vitest";
import {
  createThinkWorkerConfig,
  createThinkWorkerDefaults,
  diagnoseThinkManifest,
  diagnoseThinkWorkerConfig,
  discoverThinkApp,
  generateThinkAgentsModule,
  generateThinkEntry,
  generateThinkTypes,
  mergeThinkWorkerConfig,
  summarizeThinkManifest
} from "../framework";

describe("Think framework discovery", () => {
  it("builds top-level agent topology from /agents paths", () => {
    const manifest = discoverThinkApp({
      files: {
        "agents/support.ts": `
          import { Think } from "@cloudflare/think";
          export class SupportAgent extends Think<Env> {}
        `
      }
    });

    expect(manifest.agents).toEqual([
      {
        id: "support",
        className: "ThinkAgent_Support",
        aliases: ["support", "Support", "ThinkAgent_Support"],
        importPath: "/agents/support.ts",
        sourcePath: "agents/support.ts",
        kind: "top-level",
        features: [],
        featureSources: [],
        env: []
      }
    ]);
    expect(manifest.bindings).toEqual([
      {
        name: "ThinkAgent_Support",
        className: "ThinkAgent_Support",
        kind: "durable-object"
      }
    ]);
    expect(manifest.routes[0]?.pattern).toBe("/agents/support/*");
    expect(manifest.routePrefix).toBe("/agents");
  });

  it("generates Think type declarations for class agents", () => {
    const files = {
      "agents/host/agent.ts": "export class HostAgent {}",
      "agents/researcher/agent.ts": `
        export default class ResearcherAgent {}
      `,
      "agents/host/skills/review/SKILL.md": "# Review"
    };
    const manifest = discoverThinkApp({ files });
    manifest.agents[0]!.bindingName = "Host";
    manifest.agents[1]!.bindingName = "Researcher";

    const generated = generateThinkTypes(manifest, { files });

    expect(
      generated.find((file) => file.path === "think.d.ts")?.content
    ).toContain(
      `export const ThinkAgent_Host: (typeof import("./agents/host/agent"))["HostAgent"];`
    );
    expect(
      generated.find((file) => file.path === "think.d.ts")?.content
    ).toContain(
      `export const ThinkAgent_Researcher: (typeof import("./agents/researcher/agent")).default;`
    );
    expect(
      generated.find((file) => file.path === "think.d.ts")?.content
    ).toContain(
      `InstanceType<(typeof import("./agents/host/agent"))["HostAgent"]>`
    );
    // Bundled skills resolve through the `agents:skills` specifier, whose
    // ambient types ship from the `agents` package, so the framework no
    // longer emits a per-agent `skills.d.ts` shim.
    expect(
      generated.find((file) => file.path === "agents/host/skills.d.ts")
    ).toBeUndefined();
  });

  it("builds folder-style top-level agents and nested subagents", () => {
    const manifest = discoverThinkApp({
      files: {
        "agents/assistant/agent.ts": "export class AssistantDirectory {}",
        "agents/assistant/agents/my-assistant.ts":
          "export class MyAssistant {}",
        "agents/assistant/agents/researcher/agent.ts":
          "export default class ResearcherAgent {}"
      }
    });

    expect(manifest.agents).toMatchObject([
      {
        id: "assistant",
        className: "ThinkAgent_Assistant",
        kind: "top-level"
      },
      {
        id: "assistant/my-assistant",
        className: "ThinkSubAgent_Assistant_MyAssistant",
        aliases: [
          "assistant/my-assistant",
          "my-assistant",
          "MyAssistant",
          "ThinkSubAgent_Assistant_MyAssistant"
        ],
        kind: "subagent",
        parentId: "assistant"
      },
      {
        id: "assistant/researcher",
        className: "ThinkSubAgent_Assistant_Researcher",
        kind: "subagent",
        parentId: "assistant"
      }
    ]);
    expect(manifest.bindings).toEqual([
      {
        name: "ThinkAgent_Assistant",
        className: "ThinkAgent_Assistant",
        kind: "durable-object"
      }
    ]);
    expect(manifest.routes).toEqual([
      {
        id: "assistant",
        pattern: "/agents/assistant/*",
        agent: "ThinkAgent_Assistant"
      }
    ]);
  });

  it("discovers class agents and colocated skills by convention", () => {
    const manifest = discoverThinkApp({
      root: "/app",
      files: {
        "./agents/researcher/agent.ts": `
          export default class ResearcherAgent {}
        `,
        "agents/researcher/skills/summarize/SKILL.md": "# Summarize"
      }
    });

    expect(manifest.root).toBe("/app");
    expect(manifest.agents).toMatchObject([
      {
        id: "researcher",
        className: "ThinkAgent_Researcher",
        importPath: "/agents/researcher/agent.ts",
        sourcePath: "agents/researcher/agent.ts",
        kind: "top-level",
        features: ["skills"],
        env: []
      }
    ]);
  });

  it("tracks a custom app server handler when present", () => {
    const manifest = discoverThinkApp({
      files: {
        "agents/support.ts": "export class SupportAgent {}",
        "src/server.ts": "export default { fetch() {} }"
      }
    });

    expect(manifest.appEntrypoint).toBe("src/server.ts");
  });

  it("creates Cloudflare worker config with top-level bindings and migrations only", () => {
    const manifest = discoverThinkApp({
      files: {
        "agents/support.ts": "export class SupportAgent {}",
        "agents/support/agents/helper.ts": "export class Helper {}"
      }
    });

    expect(createThinkWorkerConfig(manifest, { name: "support-app" })).toEqual({
      name: "support-app",
      main: "virtual:think/entry",
      compatibility_date: "2026-06-11",
      compatibility_flags: ["nodejs_compat"],
      durable_objects: {
        bindings: [
          { name: "ThinkAgent_Support", class_name: "ThinkAgent_Support" }
        ]
      },
      migrations: [{ tag: "v1", new_sqlite_classes: ["ThinkAgent_Support"] }],
      assets: {
        not_found_handling: "single-page-application",
        run_worker_first: ["/agents/*", "/messengers/*", "/__think/*"]
      }
    });
  });

  it("uses custom route prefixes in routes and Worker defaults", () => {
    const manifest = discoverThinkApp({
      routePrefix: "/api/agents",
      files: {
        "agents/support.ts": "export class SupportAgent {}"
      }
    });

    expect(manifest.routes[0]?.pattern).toBe("/api/agents/support/*");
    expect(createThinkWorkerConfig(manifest).assets.run_worker_first).toEqual([
      "/api/agents/*",
      "/messengers/*",
      "/__think/*"
    ]);
  });

  it("models deterministic route surfaces for agents, subagents, and internals", () => {
    const manifest = discoverThinkApp({
      files: {
        "agents/support/agent.ts": "export class SupportAgent {}",
        "agents/support/agents/researcher.ts": "export class Researcher {}"
      }
    });

    expect(manifest.routeSurfaces).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "agent:support",
          kind: "agent",
          pattern: "/agents/support/*"
        }),
        expect.objectContaining({
          id: "subagent:support/researcher",
          kind: "subagent",
          pattern: "/agents/support/{name}/sub/researcher/{subName}"
        }),
        expect.objectContaining({
          id: "internal:think",
          kind: "internal",
          pattern: "/__think/*"
        })
      ])
    );
    expect(manifest.routeSurfaces).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: "messenger" })])
    );
  });

  it("keeps source text out of manifest inference", () => {
    const manifest = discoverThinkApp({
      files: {
        "agents/support/agent.ts": `
          export default class SupportAgent {
            schedules = [];
            tools = [createExecuteTool()];
            model = () => this.env.AI;
          }
        `,
        "agents/support/skills/review/SKILL.md": "# Review"
      }
    });

    expect(manifest.features).toEqual(["skills"]);
    expect(manifest.agents[0]).toMatchObject({
      id: "support",
      features: ["skills"],
      env: []
    });
    expect(manifest.tools).toEqual([]);
    expect(manifest.schedules).toEqual([]);
    expect(manifest.platformRequirements).toEqual([
      expect.objectContaining({
        kind: "worker_loader",
        binding: "LOADER",
        agent: "support"
      })
    ]);
  });

  it("does not follow local imports for manifest facts", () => {
    const manifest = discoverThinkApp({
      files: {
        "agents/support/agent.ts": `
          import "./tools";
          export default class SupportAgent {}
        `,
        "agents/support/tools.ts": "export const tools = [createExecuteTool()]"
      }
    });

    expect(manifest.features).toEqual([]);
    expect(manifest.env).toEqual([]);
    expect(manifest.messengers).toEqual([]);
    expect(manifest.platformRequirements).toEqual([]);
  });

  it("generates a Worker entrypoint with runtime export validation", () => {
    const manifest = discoverThinkApp({
      files: {
        "agents/support.ts": "export class SupportAgent {}",
        "agents/researcher/agent.ts": "export default class ResearcherAgent {}",
        "src/server.ts": "export default { fetch() {} }"
      }
    });

    const entry = generateThinkEntry(manifest);

    const agentsModule = generateThinkAgentsModule(manifest);

    expect(entry).toContain(
      `import { thinkRouter } from "virtual:think/router";`
    );
    expect(agentsModule).toContain(
      `import * as AgentModule0 from "/agents/researcher/agent.ts";`
    );
    expect(agentsModule).toContain(`export const thinkAgentRegistry = [`);
    expect(agentsModule).toContain(`exportName: AgentInfo0.exportName`);
    expect(entry).toContain(`import appEntrypoint from "/src/server.ts";`);
    expect(entry).toContain(`export * from "virtual:think/agents";`);
    expect(entry).toContain(`const response = await appEntrypoint.fetch`);
    expect(entry).toContain(`thinkRouter.route(request, env, ctx)`);
  });

  it("leaves invalid convention exports to generated runtime validation", () => {
    const manifest = discoverThinkApp({
      files: {
        "agents/broken.ts": "export const value = 1;"
      }
    });

    expect(manifest.agents[0]).toMatchObject({
      id: "broken",
      className: "ThinkAgent_Broken"
    });
    expect(generateThinkAgentsModule(manifest)).toContain(
      "Invalid Think agent module"
    );
  });

  it("exports only stable generated subagent names", () => {
    const manifest = discoverThinkApp({
      files: {
        "agents/assistant/agent.ts": "export class AssistantDirectory {}",
        "agents/assistant/agents/researcher.ts":
          "export class AssistantResearcher {}",
        "agents/support.ts": "export class SupportAgent {}",
        "agents/support/agents/researcher.ts":
          "export class SupportResearcher {}"
      }
    });

    const agentsModule = generateThinkAgentsModule(manifest);

    expect(agentsModule).toContain(
      `export { Agent1 as ThinkSubAgent_Assistant_Researcher };`
    );
    expect(agentsModule).toContain(
      `export { Agent3 as ThinkSubAgent_Support_Researcher };`
    );
    expect(agentsModule).not.toContain(` as Researcher`);
  });

  it("merges Worker config with user-owned binding names", () => {
    const manifest = discoverThinkApp({
      files: {
        "agents/assistant/agent.ts": "export class AssistantDirectory {}"
      }
    });
    const inferred = createThinkWorkerDefaults(manifest);
    const result = mergeThinkWorkerConfig(
      {
        name: "assistant",
        durable_objects: {
          bindings: [
            {
              name: "AssistantDirectory",
              class_name: "ThinkAgent_Assistant"
            }
          ]
        },
        migrations: [
          { tag: "v1", new_sqlite_classes: ["ThinkAgent_Assistant"] }
        ],
        assets: {
          run_worker_first: ["/auth/*", "/chat/*"]
        }
      },
      inferred
    );

    expect(result.diagnostics).toEqual([]);
    expect(result.config.durable_objects.bindings).toEqual([
      { name: "AssistantDirectory", class_name: "ThinkAgent_Assistant" }
    ]);
    expect(result.config.assets.run_worker_first).toEqual([
      "/agents/*",
      "/messengers/*",
      "/__think/*",
      "/auth/*",
      "/chat/*"
    ]);
  });

  it("diagnoses missing bindings and migrations", () => {
    const manifest = discoverThinkApp({
      files: {
        "agents/support.ts": "export class SupportAgent {}"
      }
    });

    const diagnostics = diagnoseThinkWorkerConfig(manifest, {});

    expect(diagnostics).toMatchObject([
      { code: "missing-durable-object-class", severity: "error" },
      { code: "missing-migration-class", severity: "error" }
    ]);
    expect(diagnostics[0]?.message).toContain(`agent "support"`);
    expect(diagnostics[0]?.message).toContain(`agents/support.ts`);
  });

  it("does not require facet bindings or migrations in production config", () => {
    const manifest = discoverThinkApp({
      files: {
        "agents/support.ts": "export class SupportAgent {}",
        "agents/support/agents/researcher.ts":
          "export class SupportResearcher {}"
      }
    });

    const diagnostics = diagnoseThinkWorkerConfig(manifest, {
      durable_objects: {
        bindings: [{ name: "Support", class_name: "ThinkAgent_Support" }]
      },
      migrations: [{ tag: "v1", new_sqlite_classes: ["ThinkAgent_Support"] }]
    });

    expect(diagnostics).toEqual([]);
  });

  it("diagnoses non-virtual Wrangler main unless advanced mode opts out", () => {
    const manifest = discoverThinkApp({
      files: {
        "agents/support.ts": "export class SupportAgent {}"
      }
    });
    const userConfig = {
      main: "src/server.ts",
      durable_objects: {
        bindings: [{ name: "Support", class_name: "ThinkAgent_Support" }]
      },
      migrations: [{ tag: "v1", new_sqlite_classes: ["ThinkAgent_Support"] }]
    };

    expect(diagnoseThinkWorkerConfig(manifest, userConfig)).toEqual([
      expect.objectContaining({
        code: "unexpected-worker-main",
        severity: "error"
      })
    ]);
    expect(
      diagnoseThinkWorkerConfig(manifest, userConfig, {
        allowNonVirtualMain: true
      })
    ).toEqual([]);
  });

  it("preserves user migration history and appends missing inferred classes", () => {
    const manifest = discoverThinkApp({
      files: {
        "agents/support.ts": "export class SupportAgent {}",
        "agents/sales.ts": "export class SalesAgent {}"
      }
    });

    const result = mergeThinkWorkerConfig(
      {
        migrations: [
          { tag: "v1", new_sqlite_classes: ["LegacyAgent"] },
          { tag: "v2", new_sqlite_classes: ["ThinkAgent_Support"] }
        ]
      },
      createThinkWorkerDefaults(manifest)
    );

    expect(result.config.migrations).toEqual([
      { tag: "v1", new_sqlite_classes: ["LegacyAgent"] },
      { tag: "v2", new_sqlite_classes: ["ThinkAgent_Support"] },
      {
        tag: "think-generated-v1",
        new_sqlite_classes: ["ThinkAgent_Sales"]
      }
    ]);
  });

  it("diagnoses orphan subagent topology", () => {
    const manifest = discoverThinkApp({
      files: {
        "agents/support/agents/researcher.ts":
          "export class SupportResearcher {}"
      }
    });

    expect(diagnoseThinkWorkerConfig(manifest, {})).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "orphan-subagent",
          severity: "error",
          path: "agents/support/agents/researcher.ts"
        })
      ])
    );
  });

  it("diagnoses unsupported nested subagent topology", () => {
    const manifest = discoverThinkApp({
      files: {
        "agents/support/agent.ts": "export class SupportAgent {}",
        "agents/support/agents/researcher/agent.ts":
          "export class ResearcherAgent {}",
        "agents/support/agents/researcher/agents/coder.ts":
          "export class CoderAgent {}"
      }
    });

    expect(diagnoseThinkWorkerConfig(manifest, {})).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "unsupported-nested-subagent",
          severity: "error",
          path: "agents/support/agents/researcher/agents/coder.ts"
        })
      ])
    );
    expect(manifest.routeSurfaces).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "subagent:support/researcher/coder"
        })
      ])
    );
  });

  it("diagnoses duplicate convention topology ids", () => {
    const manifest = discoverThinkApp({
      files: {
        "agents/support.ts": "export class SupportAgent {}"
      }
    });
    manifest.agents.push({ ...manifest.agents[0]! });

    expect(diagnoseThinkManifest(manifest)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "duplicate-agent-id",
          severity: "error"
        }),
        expect.objectContaining({
          code: "duplicate-generated-agent-name",
          severity: "error"
        })
      ])
    );
  });

  it("diagnoses missing Worker Loader for colocated skills", () => {
    const manifest = discoverThinkApp({
      files: {
        "agents/support/agent.ts": "export class SupportAgent {}",
        "agents/support/skills/test/SKILL.md": "# Test"
      }
    });

    expect(diagnoseThinkWorkerConfig(manifest, {})).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "missing-worker-loader-binding",
          severity: "error"
        })
      ])
    );
  });

  it("reports custom agent routing as info when an app entrypoint owns routes", () => {
    const manifest = discoverThinkApp({
      files: {
        "agents/support.ts": "export class SupportAgent {}",
        "src/server.ts": "export default { fetch() {} }"
      }
    });

    expect(
      diagnoseThinkWorkerConfig(manifest, {
        main: "virtual:think/entry",
        durable_objects: {
          bindings: [{ name: "Support", class_name: "ThinkAgent_Support" }]
        },
        migrations: [{ tag: "v1", new_sqlite_classes: ["ThinkAgent_Support"] }],
        assets: { run_worker_first: ["/chat/*"] }
      })
    ).toEqual([
      expect.objectContaining({
        code: "custom-agent-routing",
        severity: "info"
      })
    ]);
  });

  it("reports custom agent routing as warning without an app entrypoint", () => {
    const manifest = discoverThinkApp({
      files: {
        "agents/support.ts": "export class SupportAgent {}"
      }
    });

    expect(
      diagnoseThinkWorkerConfig(manifest, {
        main: "virtual:think/entry",
        durable_objects: {
          bindings: [{ name: "Support", class_name: "ThinkAgent_Support" }]
        },
        migrations: [{ tag: "v1", new_sqlite_classes: ["ThinkAgent_Support"] }],
        assets: { run_worker_first: ["/chat/*"] }
      })
    ).toEqual([
      expect.objectContaining({
        code: "custom-agent-routing",
        severity: "warning"
      })
    ]);
  });

  it("summarizes discovered routes and generated names", () => {
    const manifest = discoverThinkApp({
      routePrefix: "/api/agents",
      files: {
        "agents/support.ts": "export class SupportAgent {}",
        "agents/support/agents/researcher.ts": "export class Researcher {}"
      }
    });

    expect(summarizeThinkManifest(manifest)).toEqual([
      "Discovered 2 Think agents (1 top-level, 1 sub-agent).",
      "- support | class ThinkAgent_Support | /api/agents/support",
      "- support/researcher | class ThinkSubAgent_Support_Researcher | parent support"
    ]);
  });
});
