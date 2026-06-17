import { describe, expect, it } from "vitest";
import { resolveTarget } from "../cli/connect";
import { deriveWsTarget } from "../cli/target";
import { buildStudioConfig } from "../cli/studio-config";

const manifest = {
  agents: [
    {
      id: "support",
      className: "SupportAgent",
      bindingName: "Support",
      aliases: ["support"],
      kind: "top-level" as const,
      importPath: "./agents/support/agent",
      sourcePath: "agents/support/agent.ts",
      features: [],
      env: []
    }
  ]
};

describe("resolveTarget", () => {
  it("defaults to local Vite host and ws over a raw route segment", () => {
    const target = resolveTarget({ agent: "support", instance: "alice" });
    expect(target).toMatchObject({
      host: "localhost:5173",
      protocol: "ws",
      basePath: "agents/support/alice",
      matchedManifest: false
    });
  });

  it("kebab-cases a camelCase agent segment when there is no manifest", () => {
    const target = resolveTarget({ agent: "SupportAgent" });
    expect(target.basePath).toBe("agents/support-agent/default");
  });

  it("derives host and wss from a remote --url", () => {
    const target = resolveTarget({
      agent: "support",
      url: "https://app.example.com"
    });
    expect(target.host).toBe("app.example.com");
    expect(target.protocol).toBe("wss");
  });

  it("collects token and repeated --query params", () => {
    const target = resolveTarget({
      agent: "support",
      token: "secret",
      query: ["team=ops", "trace=1"]
    });
    expect(target.query).toEqual({ token: "secret", team: "ops", trace: "1" });
  });

  it("resolves friendly manifest ids through the manifest", () => {
    const target = resolveTarget({ agent: "support", manifest });
    expect(target.matchedManifest).toBe(true);
    expect(target.basePath).toBe("agents/support/default");
  });

  it("honors a custom route prefix", () => {
    const target = resolveTarget({
      agent: "support",
      routePrefix: "/api/agents"
    });
    expect(target.basePath).toBe("api/agents/support/default");
  });

  it("throws on a malformed --query value", () => {
    expect(() => resolveTarget({ agent: "support", query: ["nope"] })).toThrow(
      /key=value/
    );
  });
});

describe("deriveWsTarget", () => {
  it("defaults to the local Vite host over ws", () => {
    const target = deriveWsTarget({ agent: "support" });
    expect(target).toMatchObject({
      host: "localhost:5173",
      protocol: "ws",
      basePath: "agents/support/default",
      segment: "support"
    });
  });

  it("kebab-cases a non-canonical agent segment", () => {
    const target = deriveWsTarget({ agent: "SupportAgent" });
    expect(target.basePath).toBe("agents/support-agent/default");
    expect(target.segment).toBe("support-agent");
  });

  it("uses a canonical agent verbatim", () => {
    const target = deriveWsTarget({ agent: "MyId", canonicalAgent: true });
    expect(target.segment).toBe("MyId");
    expect(target.basePath).toBe("agents/MyId/default");
  });

  it("derives wss from a remote https url", () => {
    const target = deriveWsTarget({
      agent: "support",
      url: "https://app.example.com"
    });
    expect(target.host).toBe("app.example.com");
    expect(target.protocol).toBe("wss");
  });

  it("maps a token and a query record into the query object", () => {
    const target = deriveWsTarget({
      agent: "support",
      token: "secret",
      query: { team: "ops" }
    });
    expect(target.query).toEqual({ token: "secret", team: "ops" });
  });

  it("parses key=value query strings", () => {
    const target = deriveWsTarget({
      agent: "support",
      query: ["a=1", "b=2"]
    });
    expect(target.query).toEqual({ a: "1", b: "2" });
  });

  it("encodes the instance into the basePath", () => {
    const target = deriveWsTarget({ agent: "support", instance: "user/42" });
    expect(target.basePath).toBe("agents/support/user%2F42");
  });

  it("throws on a malformed query string", () => {
    expect(() => deriveWsTarget({ agent: "support", query: ["nope"] })).toThrow(
      /key=value/
    );
  });
});

describe("buildStudioConfig", () => {
  it("returns the target and an empty agent list without a manifest", () => {
    const config = buildStudioConfig({
      target: { host: "localhost:5173", agent: "support" }
    });
    expect(config.agents).toEqual([]);
    expect(config.target).toEqual({ host: "localhost:5173", agent: "support" });
  });

  it("maps top-level manifest agents into picker options", () => {
    const config = buildStudioConfig({ target: {}, manifest });
    expect(config.agents).toEqual([{ id: "support", label: "Support" }]);
  });

  it("ignores non-top-level manifest entries", () => {
    const config = buildStudioConfig({
      target: {},
      manifest: {
        agents: [
          { id: "child", kind: "sub", bindingName: "Child" },
          { id: "root", kind: "top-level", bindingName: "Root" }
        ]
      }
    });
    expect(config.agents).toEqual([{ id: "root", label: "Root" }]);
  });
});
