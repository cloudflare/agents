import { env, exports } from "cloudflare:workers";
import { createExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  buildThinkAgentPath,
  createThinkRouter,
  createThinkWorkerEntry,
  parseThinkAgentPath,
  resolveThinkSubAgentName,
  rewriteThinkSubAgentRequest,
  routeThinkRequest
} from "../server-entry";
import type { ThinkFrameworkManifest } from "../framework";

describe("Think host embedding helpers", () => {
  it("lets app handlers own routes before falling through to Think", async () => {
    const entry = createThinkWorkerEntry({
      fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === "/app") {
          return new Response("app route");
        }
        return null;
      }
    });

    await expect(
      entry.fetch(new Request("https://example.com/app"), env, executionCtx())
    ).resolves.toMatchObject({ status: 200 });

    await expect(
      entry.fetch(
        new Request("https://example.com/not-a-think-route"),
        env,
        executionCtx()
      )
    ).resolves.toMatchObject({ status: 404 });
  });

  it("routes Think requests in the Workers runtime", async () => {
    const response = await routeThinkRequest(
      new Request("https://example.com/agents/think-test-agent/host-test"),
      env,
      executionCtx()
    );

    expect(response).toBeInstanceOf(Response);
  });

  it("injects Think router context into custom app handlers", async () => {
    const manifest = {
      agents: [
        {
          id: "support",
          className: "ThinkAgent_Support",
          aliases: ["support", "Support", "ThinkAgent_Support"],
          kind: "top-level",
          importPath: "/agents/support.ts",
          sourcePath: "agents/support.ts",
          features: [],
          env: []
        }
      ]
    } satisfies Pick<ThinkFrameworkManifest, "agents">;
    const entry = createThinkWorkerEntry({
      manifest,
      fetch(_request, _env, _ctx, think) {
        return new Response(think?.router ? "has router" : "missing router");
      }
    });

    const response = await entry.fetch(
      new Request("https://example.com/app"),
      env,
      executionCtx()
    );

    expect(await response!.text()).toBe("has router");
  });

  it("keeps generated Durable Object exports available", () => {
    expect(exports.ThinkTestAgent).toBeDefined();
  });

  it("resolves friendly subagent aliases through manifest metadata", () => {
    const manifest = {
      agents: [
        {
          id: "assistant",
          className: "ThinkAgent_Assistant",
          aliases: ["assistant", "Assistant"],
          kind: "top-level",
          importPath: "/agents/assistant/agent.ts",
          sourcePath: "agents/assistant/agent.ts",
          features: [],
          env: []
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
          parentId: "assistant",
          importPath: "/agents/assistant/agents/my-assistant.ts",
          sourcePath: "agents/assistant/agents/my-assistant.ts",
          features: [],
          env: []
        }
      ]
    } satisfies Pick<ThinkFrameworkManifest, "agents">;

    expect(
      resolveThinkSubAgentName(manifest, "assistant", "my-assistant")
    ).toBe("ThinkSubAgent_Assistant_MyAssistant");
  });

  it("builds and parses friendly Think agent paths", () => {
    const manifest = {
      agents: [
        {
          id: "assistant",
          className: "ThinkAgent_Assistant",
          aliases: ["assistant", "Assistant"],
          kind: "top-level",
          importPath: "/agents/assistant/agent.ts",
          sourcePath: "agents/assistant/agent.ts",
          features: [],
          env: []
        },
        {
          id: "assistant/my-assistant",
          className: "ThinkSubAgent_Assistant_MyAssistant",
          aliases: ["assistant/my-assistant", "my-assistant", "MyAssistant"],
          kind: "subagent",
          parentId: "assistant",
          importPath: "/agents/assistant/agents/my-assistant.ts",
          sourcePath: "agents/assistant/agents/my-assistant.ts",
          features: [],
          env: []
        }
      ]
    } satisfies Pick<ThinkFrameworkManifest, "agents">;

    const path = buildThinkAgentPath(
      {
        agent: "ThinkAgent_Assistant",
        name: "sunil",
        sub: [{ agent: "MyAssistant", name: "chat-1" }]
      },
      { routePrefix: "/api/agents", manifest }
    );

    expect(path).toBe("/api/agents/assistant/sunil/sub/my-assistant/chat-1");
    expect(parseThinkAgentPath(path, { routePrefix: "/api/agents" })).toEqual({
      agent: "assistant",
      name: "sunil",
      sub: [{ agent: "my-assistant", name: "chat-1" }]
    });
  });

  it("rewrites friendly subagent segments to scoped generated names", () => {
    const manifest = {
      agents: [
        {
          id: "support",
          className: "ThinkAgent_Support",
          aliases: ["support", "Support", "ThinkAgent_Support"],
          kind: "top-level",
          importPath: "/agents/support.ts",
          sourcePath: "agents/support.ts",
          features: [],
          env: []
        },
        {
          id: "support/researcher",
          className: "ThinkSubAgent_Support_Researcher",
          aliases: [
            "support/researcher",
            "researcher",
            "Researcher",
            "ThinkSubAgent_Support_Researcher"
          ],
          kind: "subagent",
          parentId: "support",
          importPath: "/agents/support/agents/researcher.ts",
          sourcePath: "agents/support/agents/researcher.ts",
          features: [],
          env: []
        },
        {
          id: "sales",
          className: "ThinkAgent_Sales",
          aliases: ["sales", "Sales", "ThinkAgent_Sales"],
          kind: "top-level",
          importPath: "/agents/sales.ts",
          sourcePath: "agents/sales.ts",
          features: [],
          env: []
        },
        {
          id: "sales/researcher",
          className: "ThinkSubAgent_Sales_Researcher",
          aliases: [
            "sales/researcher",
            "researcher",
            "Researcher",
            "ThinkSubAgent_Sales_Researcher"
          ],
          kind: "subagent",
          parentId: "sales",
          importPath: "/agents/sales/agents/researcher.ts",
          sourcePath: "agents/sales/agents/researcher.ts",
          features: [],
          env: []
        }
      ]
    } satisfies Pick<ThinkFrameworkManifest, "agents">;

    const support = rewriteThinkSubAgentRequest(
      new Request("https://example.com/chat/sub/researcher/child"),
      { manifest, parent: "support" }
    );
    const sales = rewriteThinkSubAgentRequest(
      new Request("https://example.com/chat/sub/researcher/child"),
      { manifest, parent: "sales" }
    );

    expect(new URL(support.url).pathname).toBe(
      "/chat/sub/think-sub-agent--support--researcher/child"
    );
    expect(new URL(sales.url).pathname).toBe(
      "/chat/sub/think-sub-agent--sales--researcher/child"
    );
  });

  it("normalizes friendly subagent segments before forwarding to the parent", async () => {
    const manifest = {
      agents: [
        {
          id: "support",
          className: "ThinkAgent_Support",
          aliases: ["support", "Support", "ThinkAgent_Support"],
          kind: "top-level",
          importPath: "/agents/support.ts",
          sourcePath: "agents/support.ts",
          features: [],
          env: []
        },
        {
          id: "support/researcher",
          className: "ThinkSubAgent_Support_Researcher",
          aliases: ["support/researcher", "researcher", "Researcher"],
          kind: "subagent",
          parentId: "support",
          importPath: "/agents/support/agents/researcher.ts",
          sourcePath: "agents/support/agents/researcher.ts",
          features: [],
          env: []
        }
      ]
    } satisfies Pick<ThinkFrameworkManifest, "agents">;
    const router = createThinkRouter({ manifest });
    const original = new Request(
      "https://example.com/chat/sub/researcher/child"
    );

    const response = await router.routeSubAgent(
      original,
      {
        async fetch(request) {
          return Response.json({
            url: request.url
          });
        }
      },
      { parent: "support" }
    );

    expect(await response.json()).toEqual({
      url: "https://example.com/chat/sub/think-sub-agent--support--researcher/child"
    });
  });

  it("returns 404 for unresolved user-addressed subagent routes", async () => {
    const manifest = {
      agents: [
        {
          id: "support",
          className: "ThinkAgent_Support",
          aliases: ["support", "Support", "ThinkAgent_Support"],
          kind: "top-level",
          importPath: "/agents/support.ts",
          sourcePath: "agents/support.ts",
          features: [],
          env: []
        }
      ]
    } satisfies Pick<ThinkFrameworkManifest, "agents">;
    let parentCalled = false;
    const router = createThinkRouter({ manifest });

    const response = await router.routeSubAgent(
      new Request("https://example.com/chat/sub/missing/child"),
      {
        async fetch() {
          parentCalled = true;
          return new Response("parent");
        }
      },
      { parent: "support" }
    );

    expect(response.status).toBe(404);
    expect(parentCalled).toBe(false);
  });

  it("returns 404 when a later nested subagent segment is unresolved", async () => {
    const manifest = {
      agents: [
        {
          id: "support",
          className: "ThinkAgent_Support",
          aliases: ["support", "Support", "ThinkAgent_Support"],
          kind: "top-level",
          importPath: "/agents/support.ts",
          sourcePath: "agents/support.ts",
          features: [],
          env: []
        },
        {
          id: "support/researcher",
          className: "ThinkSubAgent_Support_Researcher",
          aliases: ["support/researcher", "researcher", "Researcher"],
          kind: "subagent",
          parentId: "support",
          importPath: "/agents/support/agents/researcher.ts",
          sourcePath: "agents/support/agents/researcher.ts",
          features: [],
          env: []
        }
      ]
    } satisfies Pick<ThinkFrameworkManifest, "agents">;
    let parentCalled = false;
    const router = createThinkRouter({ manifest });

    const response = await router.routeSubAgent(
      new Request(
        "https://example.com/chat/sub/researcher/child/sub/missing/grandchild"
      ),
      {
        async fetch() {
          parentCalled = true;
          return new Response("parent");
        }
      },
      { parent: "support" }
    );

    expect(response.status).toBe(404);
    expect(parentCalled).toBe(false);
  });

  it("continues forwarding no-sub app paths to the parent agent", async () => {
    const manifest = {
      agents: [
        {
          id: "support",
          className: "ThinkAgent_Support",
          aliases: ["support", "Support", "ThinkAgent_Support"],
          kind: "top-level",
          importPath: "/agents/support.ts",
          sourcePath: "agents/support.ts",
          features: [],
          env: []
        }
      ]
    } satisfies Pick<ThinkFrameworkManifest, "agents">;
    const router = createThinkRouter({ manifest });

    const response = await router.routeSubAgent(
      new Request("https://example.com/chat"),
      {
        async fetch() {
          return new Response("parent");
        }
      },
      { parent: "support" }
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("parent");
  });
});

function executionCtx(): ExecutionContext {
  return createExecutionContext();
}
