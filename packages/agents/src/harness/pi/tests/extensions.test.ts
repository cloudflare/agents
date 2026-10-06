import { env } from "cloudflare:workers";
import { evictDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

function fresh() {
  return env.PI_EXTENSIONS_TEST.getByName(crypto.randomUUID());
}

describe("portable extensions on PiHarness", () => {
  it("offers portable tools, sections and skills next to native ones", async () => {
    const offered = await fresh().inspect();
    expect(offered.tools).toEqual(
      [
        "activate_skill",
        "add",
        "fetch_content",
        "make_tool",
        "mcp__docs__search",
        "read_skill_resource",
        "shell",
        "subagent",
        "web_search"
      ].sort()
    );
    expect(offered.sections["web"]).toContain("web_search");
    expect(offered.sections["skills"]).toContain("delegation");
  });

  it("validates against the JSON Schema, then parses with the tool's schema", async () => {
    const stub = fresh();
    expect(await stub.prompt('call add {"a":2,"b":3}')).toMatchObject({
      text: "tool said: 5"
    });
    // pi checks the JSON Schema the model was shown.
    expect(
      await stub.prompt('call fetch_content {"url":"not a url"}')
    ).toMatchObject({ text: expect.stringContaining("must match format") });
    // The tool's own schema catches what JSON Schema cannot say.
    expect(await stub.prompt('call add {"a":99,"b":2}')).toMatchObject({
      text: "tool failed: Invalid input: sum over 100"
    });
  });

  it("runs ported web access tools", async () => {
    const stub = fresh();
    expect(await stub.prompt('call web_search {"query":"pi"}')).toMatchObject({
      text: expect.stringContaining("About pi")
    });
    expect(
      await stub.prompt('call fetch_content {"url":"https://example.com/a"}')
    ).toMatchObject({ text: "tool said: page at https://example.com/a" });
  });

  it("reloads MCP tools from scratch when the server changes", async () => {
    const stub = fresh();
    expect(await stub.prompt('call mcp__docs__search {"q":"x"}')).toMatchObject(
      { text: 'tool said: docs search({"q":"x"})' }
    );
    await stub.setMcpTools(["lookup"]);
    const offered = await stub.inspect();
    expect(offered.tools).toContain("mcp__docs__lookup");
    expect(offered.tools).not.toContain("mcp__docs__search");
    expect(await stub.prompt('call mcp__docs__search {"q":"x"}')).toMatchObject(
      { text: expect.stringMatching(/^tool failed/) }
    );
  });

  it("lets the agent make a tool and call it in the same run", async () => {
    const stub = fresh();
    expect(await stub.prompt('call make_tool {"name":"greet"}')).toMatchObject({
      text: "tool said: hello from greet"
    });
  });

  it("hooks every tool call, native tools included", async () => {
    const stub = fresh();
    expect(
      await stub.prompt('call shell {"command":"rm -rf /"}')
    ).toMatchObject({ text: expect.stringContaining("destructive command") });
    expect(await stub.prompt('call shell {"command":"ls"}')).toMatchObject({
      text: "tool said: ran ls, key [redacted]"
    });
  });

  it("runs a subagent in a child session", async () => {
    const stub = fresh();
    expect(
      await stub.prompt('call subagent {"agent":"oracle","task":"hello"}')
    ).toMatchObject({ text: "tool said: echo: oracle: hello" });
  });

  it("removes everything an extension registered", async () => {
    const stub = fresh();
    expect(await stub.removeExtension("guard")).toBe(true);
    expect(await stub.prompt('call shell {"command":"ls"}')).toMatchObject({
      text: "tool said: ran ls, key sk-123"
    });
    expect(await stub.removeExtension("pi-web-access")).toBe(true);
    const offered = await stub.inspect();
    expect(offered.tools).not.toContain("web_search");
    expect(offered.sections["web"]).toBeUndefined();
  });

  it("re-runs setup after an eviction and keeps working", async () => {
    const stub = fresh();
    await stub.setMcpTools(["lookup"]);
    expect(await stub.setupRuns()).toBe(1);
    await evictDurableObject(stub);
    expect(await stub.prompt('call add {"a":1,"b":1}')).toMatchObject({
      text: "tool said: 2"
    });
    expect(await stub.setupRuns()).toBe(2);
    // The MCP tool list came back from the server's stored config.
    expect((await stub.inspect()).tools).toContain("mcp__docs__lookup");
  });
});
