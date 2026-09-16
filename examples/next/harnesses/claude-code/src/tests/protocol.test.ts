import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { ClaudeCodeProtocolTestObject } from "./worker";

function object(): DurableObjectStub<ClaudeCodeProtocolTestObject> {
  return env.CLAUDE_CODE_PROTOCOL_TEST.getByName(crypto.randomUUID());
}

describe("the Claude Code example inside a Worker", () => {
  it("builds an engine spec the container runtime can carry", async () => {
    const spec = await object().spec();
    expect(spec.id).toBe("claude-code");
    // The options are opaque to the wire: they travel as JSON and the engine
    // inside the container parses them.
    expect(JSON.parse(spec.optionsJson)).toEqual({
      model: "claude-opus-5",
      permissionMode: "default",
      allowedTools: ["Read"],
      ask: ["Bash"],
      budget: { maxUsd: 5 }
    });
    expect(spec.capabilities.sort()).toEqual([
      "compact",
      "requests",
      "steer",
      "usage"
    ]);
  });

  it("loads the session class in the Workers runtime", async () => {
    expect(await object().sessionClassName()).toBe("ClaudeCodeSession");
  });
});
