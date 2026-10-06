import { env } from "cloudflare:workers";
import {
  abortAllDurableObjects,
  evictDurableObject,
  runDurableObjectAlarm
} from "cloudflare:test";
import { describe, expect, it } from "vitest";

function fresh(name: string = crypto.randomUUID()) {
  return env.PI_EXTENSIONS_TEST.getByName(name);
}

describe("portable extensions on PiHarness", () => {
  it("offers native and portable tools, but not deferred ones", async () => {
    const offered = await fresh().inspect();
    expect(offered.tools).toEqual(
      [
        "activate_skill",
        "add",
        "ask_user_question",
        "make_tool",
        "mcp_enable",
        "read_skill_resource",
        "shell",
        "subagent",
        "web_enable"
      ].sort()
    );
    expect(offered.sections["web"]).toContain("web_enable");
    expect(offered.sections["skills"]).toContain("delegation");
  });

  it("validates against the JSON Schema, then parses with the tool's schema", async () => {
    const stub = fresh();
    expect(await stub.prompt('call add {"a":2,"b":3}')).toMatchObject({
      text: "tool said: 5"
    });
    expect(await stub.prompt('call add {"a":"x","b":3}')).toMatchObject({
      text: expect.stringContaining("Validation failed")
    });
    expect(await stub.prompt('call add {"a":99,"b":2}')).toMatchObject({
      text: "tool failed: Invalid input: sum over 100"
    });
  });

  describe("1. per-session tool selection", () => {
    it("a loader's result offers deferred tools to its session only, from the next request", async () => {
      const stub = fresh();
      const other = await stub.createSession();
      // web_enable's result activates web_search; the model calls it in the same run.
      expect(await stub.prompt("call web_enable {}")).toMatchObject({
        text: expect.stringContaining("About same run")
      });
      expect((await stub.inspect()).tools).toEqual(
        expect.arrayContaining(["web_search", "fetch_content"])
      );
      expect((await stub.inspect(other)).tools).not.toContain("web_search");
      await evictDurableObject(stub);
      expect((await stub.inspect()).tools).toContain("web_search");
    });

    it("refuses a deferred tool the session has not activated", async () => {
      const stub = fresh();
      expect(await stub.prompt('call web_search {"query":"x"}')).toMatchObject({
        text: expect.stringContaining("not available")
      });
    });

    it("keeps deferred MCP tools behind mcp_enable and reloads them from scratch", async () => {
      const stub = fresh();
      await stub.prompt("call mcp_enable {}");
      expect(
        await stub.prompt('call mcp__docs__search {"q":"x"}')
      ).toMatchObject({ text: 'tool said: docs search({"q":"x"})' });
      await stub.setMcpTools(["lookup"]);
      expect((await stub.inspect()).tools).not.toContain("mcp__docs__search");
      await stub.prompt("call mcp_enable {}");
      expect((await stub.inspect()).tools).toContain("mcp__docs__lookup");
    });
  });

  describe("2. commands, asking the user, injected messages", () => {
    it("lists commands and runs one that only answers, once per operation id", async () => {
      const stub = fresh();
      expect((await stub.commands()).map((c) => c.name).sort()).toEqual([
        "later",
        "mcp",
        "note",
        "parallel-review"
      ]);
      const first = await stub.submit("/note hello", "op-note");
      expect(first.accepted).toBe(true);
      expect(await stub.wait("op-note")).toEqual({
        status: "done",
        text: "noted"
      });
      expect((await stub.submit("/note hello", "op-note")).accepted).toBe(
        false
      );
      expect(await stub.notes()).toEqual(["hello"]);
    });

    it("turns a prompt-template command into an ordinary prompt", async () => {
      const stub = fresh();
      expect(await stub.prompt("/parallel-review the diff")).toMatchObject({
        text: "echo: Review in parallel: the diff"
      });
    });

    it("submits a message to a session from an extension", async () => {
      const stub = fresh();
      await stub.prompt("/later queued work");
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        const events = await stub.events();
        if (events.includes("turn.end echo: queued work")) return;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      throw new Error("The queued prompt never ran");
    });

    it("a tool asks the user and resumes with the answer", async () => {
      const stub = fresh();
      const receipt = await stub.submit(
        'call ask_user_question {"question":"Which?","options":["A","B"]}'
      );
      const request = await stub.nextRequest();
      expect(request).toMatchObject({
        tool: "ask_user_question",
        request: { kind: "select", message: "Which?", options: ["A", "B"] }
      });
      expect(await stub.reply(request.id, "C")).toMatchObject({
        accepted: false,
        reason: "invalid"
      });
      expect(await stub.reply(request.id, "B")).toEqual({ accepted: true });
      expect(await stub.wait(receipt.operationId)).toMatchObject({
        text: "tool said: The user chose: B"
      });
      expect(await stub.requests()).toEqual([]);
    });

    it("an asked question survives a crash and is not asked twice", async () => {
      const name = crypto.randomUUID();
      let stub = fresh(name);
      const receipt = await stub.submit(
        'call ask_user_question {"question":"Which?","options":["A","B"]}'
      );
      const request = await stub.nextRequest();
      // A graceful eviction waits for the call, which waits for the person,
      // so crash the object instead. The wake job's alarm restarts it.
      await abortAllDurableObjects();
      stub = fresh(name);
      expect(await runDurableObjectAlarm(stub)).toBe(true);
      const again = await stub.nextRequest();
      expect(again.id).toBe(request.id);
      await stub.reply(request.id, "A");
      expect(await stub.wait(receipt.operationId)).toMatchObject({
        text: "tool said: The user chose: A"
      });
    });

    it("a hook asks before a native tool runs; declining blocks it", async () => {
      const stub = fresh();
      const yes = await stub.submit('call shell {"command":"deploy prod"}');
      await stub.reply((await stub.nextRequest()).id, true);
      expect(await stub.wait(yes.operationId)).toMatchObject({
        text: "tool said: ran deploy prod, key [redacted]"
      });
      const no = await stub.submit('call shell {"command":"deploy prod"}');
      await stub.reply((await stub.nextRequest()).id, false);
      expect(await stub.wait(no.operationId)).toMatchObject({
        text: expect.stringContaining("The user declined")
      });
    });
  });

  describe("3. lifecycle events", () => {
    it("reports sessions, tool calls and final answers", async () => {
      const stub = fresh();
      const session = await stub.createSession();
      await stub.prompt('call add {"a":1,"b":2}');
      expect(await stub.events()).toEqual(
        expect.arrayContaining([
          `session.created ${session}`,
          "tool.end add {}",
          "turn.end tool said: 3"
        ])
      );
    });
  });

  describe("4. native tools in the draft", () => {
    it("removes and re-describes native tools, and hooks still see them", async () => {
      const stub = fresh();
      const offered = await stub.inspect();
      expect(offered.tools).toContain("shell");
      expect(offered.tools).not.toContain("legacy");
      expect(await stub.prompt('call legacy {"command":"x"}')).toMatchObject({
        text: expect.stringContaining("not available")
      });
      expect(
        await stub.prompt('call shell {"command":"rm -rf /"}')
      ).toMatchObject({ text: expect.stringContaining("destructive command") });
    });
  });

  describe("5. tool-result metadata", () => {
    it("carries native details and portable metadata to hooks and events", async () => {
      const stub = fresh();
      await stub.prompt('call shell {"command":"ls"}');
      await stub.prompt("call web_enable {}");
      const events = await stub.events();
      expect(events).toContain('tool.end shell {"exit":0}');
      expect(events).toContain('tool.end web_search {"results":1}');
    });
  });

  describe("6. state across evictions", () => {
    it("a tool the agent made itself comes back after an eviction", async () => {
      const stub = fresh();
      expect(
        await stub.prompt('call make_tool {"name":"greet"}')
      ).toMatchObject({ text: "tool said: hello from greet" });
      expect(await stub.starts()).toBe(1);
      await evictDurableObject(stub);
      expect(await stub.prompt("call greet {}")).toMatchObject({
        text: "tool said: hello from greet"
      });
      expect(await stub.starts()).toBe(2);
    });

    it("keeps per-session state for a session's later calls", async () => {
      const stub = fresh();
      await stub.prompt("call web_enable {}");
      await stub.prompt('call fetch_content {"url":"https://example.com/a"}');
      expect(
        await stub.prompt(
          'call get_search_content {"url":"https://example.com/a"}'
        )
      ).toMatchObject({ text: "tool said: page at https://example.com/a" });
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
    expect(await stub.removeExtension("web")).toBe(true);
    const offered = await stub.inspect();
    expect(offered.tools).not.toContain("web_enable");
    expect(offered.sections["web"]).toBeUndefined();
  });
});
