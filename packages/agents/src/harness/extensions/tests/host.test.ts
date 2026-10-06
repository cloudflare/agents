import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  ExtensionHost,
  memoryKeyValueStore,
  RequestStore,
  type Extension,
  type ExtensionFeature,
  type ExtensionReport,
  type ExtensionSession,
  type ExtensionSnapshot,
  type NativeTool,
  type Tool
} from "../index";

const ALL: ExtensionFeature[] = [
  "tool",
  "tool.deferred",
  "tool.native.remove",
  "tool.native.update",
  "tool.execute.before",
  "tool.execute.after",
  "tool.ask",
  "instructions",
  "skill",
  "command",
  "event",
  "session.submit",
  "session.note"
];

const noSession = (id: string): ExtensionSession => ({
  id,
  submit: async () => ({ accepted: true }),
  note: async () => ({ accepted: true }),
  tools: {
    activate: async () => {},
    deactivate: async () => {},
    offered: async () => []
  }
});

/** A host that records what it publishes and reports. */
function host(
  options: {
    readonly features?: ExtensionFeature[];
    readonly natives?: NativeTool[];
  } = {}
) {
  const published: ExtensionSnapshot[] = [];
  const reports: ExtensionReport[] = [];
  const store = memoryKeyValueStore();
  const extensions = new ExtensionHost({
    harness: "test",
    features: options.features ?? ALL,
    store,
    session: noSession,
    nativeTools: () => options.natives ?? [],
    onPublish: (snapshot) => {
      published.push(snapshot);
    },
    onReport: (report) => reports.push(report)
  });
  const tools = () =>
    Object.fromEntries(
      extensions
        .snapshot()
        .tools.map((tool) => [tool.id, tool.description] as const)
    );
  return { extensions, published, reports, tools, store };
}

function tool(id: string, description = id): Tool {
  return {
    id,
    description,
    input: z.object({}),
    execute: () => ({ content: id })
  };
}

const call = { session: "1", callId: "c1" };

describe("ExtensionHost", () => {
  // The bugs in https://anoma.ly/notes/opencode-reloaded/, one by one.
  it("rebuilds from empty, so a refresh cannot undo a policy or stack an edit", async () => {
    const { extensions, tools } = host();
    let catalog = ["gpt", "perinium"];
    let refresh = async () => {};
    await extensions.add(function catalogSource(ctx) {
      ctx.tool.transform((draft) => {
        for (const id of catalog) draft.add(tool(id, "128"));
      });
      refresh = () => ctx.tool.reload();
    });
    await extensions.add(function policy(ctx) {
      ctx.tool.transform((draft) => draft.remove("perinium"));
    });
    await extensions.add(function halve(ctx) {
      ctx.tool.transform((draft) => {
        for (const each of draft.list()) {
          draft.update(each.id, (t) => ({
            ...t,
            description: String(Number(t.description) / 2)
          }));
        }
      });
    });
    expect(tools()).toEqual({ gpt: "64" });

    catalog = ["gpt", "perinium", "local"];
    await refresh();
    await refresh();
    expect(tools()).toEqual({ gpt: "64", local: "64" });

    catalog = ["local"];
    await refresh();
    expect(tools()).toEqual({ local: "64" });
  });

  it("batches an extension's start into one rebuild per domain", async () => {
    const { extensions, published } = host();
    await extensions.add((ctx) => {
      ctx.tool.add(tool("a"));
      ctx.tool.add(tool("b"));
      ctx.instructions.set("k", "v");
    });
    expect(published).toHaveLength(2);
    expect(published.at(-1)?.tools.map((t) => t.id)).toEqual(["a", "b"]);
    expect(published.at(-1)?.instructions).toEqual([{ key: "k", text: "v" }]);
  });

  it("coalesces concurrent reloads into one more rebuild", async () => {
    const { extensions, published } = host();
    let reload = async () => {};
    await extensions.add((ctx) => {
      ctx.tool.transform(async (d) => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        d.add(tool("a"));
      });
      reload = () => ctx.tool.reload();
    });
    const before = published.length;
    await Promise.all([reload(), reload()]);
    expect(published.length - before).toBe(1);
    const running = reload();
    await new Promise((resolve) => setTimeout(resolve, 1));
    await Promise.all([reload(), reload(), reload(), running]);
    expect(published.length - before).toBe(3);
  });

  it("disposes one registration, or everything when the extension goes", async () => {
    const { extensions, tools } = host();
    let cleaned = 0;
    let disposeB = async () => {};
    const x: Extension = (ctx) => {
      ctx.tool.add(tool("a"));
      disposeB = ctx.tool.add(tool("b")).dispose;
      ctx.tool.hook("execute.before", (e) => {
        e.block = "no";
      });
      return () => {
        cleaned++;
      };
    };
    await extensions.add(x);
    await disposeB();
    await disposeB();
    expect(tools()).toEqual({ a: "a" });
    expect(extensions.hooks("execute.before")).toBe(true);

    expect(await extensions.remove(x)).toBe(true);
    expect(await extensions.remove(x)).toBe(false);
    expect(tools()).toEqual({});
    expect(extensions.hooks("execute.before")).toBe(false);
    expect(cleaned).toBe(1);
  });

  it("rolls back an extension that throws, and refuses one added twice", async () => {
    const { extensions, tools } = host();
    const added = await extensions.add(function broken(ctx) {
      ctx.tool.add(tool("half"));
      throw new Error("boom");
    });
    expect(added).toMatchObject({
      _tag: "err",
      error: { _tag: "ExtensionSetupFailed", extension: "broken" }
    });
    expect(tools()).toEqual({});
    expect(extensions.installed()).toEqual([]);

    const ok: Extension = () => {};
    expect(await extensions.add(ok)).toEqual({ _tag: "ok" });
    expect(await extensions.add(ok)).toMatchObject({
      error: { _tag: "ExtensionAlreadyInstalled" }
    });
  });

  it("fails an extension that uses a missing feature, unless it checks", async () => {
    const { extensions } = host({ features: ["tool"] });
    expect(
      await extensions.add((ctx) => {
        ctx.tool.hook("execute.after", () => {});
      })
    ).toMatchObject({
      error: {
        cause: {
          _tag: "ExtensionFeatureUnsupported",
          feature: "tool.execute.after"
        }
      }
    });
    expect(
      await extensions.add((ctx) => {
        if (ctx.supports("tool.execute.after")) {
          ctx.tool.hook("execute.after", () => {});
        }
      })
    ).toEqual({ _tag: "ok" });
  });

  it("chains before hooks; the first block or throw stops the call", async () => {
    const { extensions } = host();
    await extensions.add((ctx) => {
      ctx.tool.hook("execute.before", (e) => {
        e.input = { ...e.input, n: 1 };
      });
      ctx.tool.hook("execute.before", (e) => {
        e.input = { ...e.input, m: e.input["n"] ?? null };
      });
      ctx.tool.hook("execute.before", (e) => {
        if (e.tool === "danger") throw new Error("not allowed");
        if (e.tool === "deploy") e.ask = "Deploy?";
      });
      ctx.tool.hook("execute.before", (e) => {
        e.input = { ...e.input, last: true };
      });
    });
    const edited = await extensions.beforeTool({
      ...call,
      tool: "t",
      input: {}
    });
    expect(edited).toMatchObject({ input: { n: 1, m: 1, last: true } });
    expect(edited.block).toBeUndefined();
    expect(
      await extensions.beforeTool({ ...call, tool: "danger", input: {} })
    ).toMatchObject({ block: "not allowed", input: { n: 1, m: 1 } });
    expect(
      await extensions.beforeTool({ ...call, tool: "deploy", input: {} })
    ).toMatchObject({ ask: "Deploy?", input: { last: true } });
  });

  it("chains after hooks, then tells tool.end handlers", async () => {
    const { extensions, reports } = host();
    const ended: string[] = [];
    await extensions.add(function after(ctx) {
      ctx.tool.hook("execute.after", () => {
        throw new Error("oops");
      });
      ctx.tool.hook("execute.after", (e) => {
        e.result = { ...e.result, metadata: { seen: true } };
      });
      ctx.event.on("tool.end", (e) => {
        ended.push(JSON.stringify(e.result.metadata));
      });
    });
    const event = await extensions.afterTool({
      ...call,
      tool: "t",
      input: {},
      result: { content: "ok" }
    });
    expect(event.result).toEqual({ content: "ok", metadata: { seen: true } });
    expect(ended).toEqual(['{"seen":true}']);
    expect(reports).toMatchObject([{ _tag: "HookFailed", extension: "after" }]);
  });

  it("reports a failing transform or handler and keeps the others", async () => {
    const { extensions, reports, tools } = host();
    await extensions.add(function mixed(ctx) {
      ctx.tool.transform(() => {
        throw new Error("bad");
      });
      ctx.tool.add(tool("good"));
      ctx.event.on("turn.end", () => {
        throw new Error("handler");
      });
    });
    await extensions.emit("turn.end", { session: "1", text: "" });
    expect(tools()).toEqual({ good: "good" });
    expect(reports).toMatchObject([
      { _tag: "TransformFailed", extension: "mixed", domain: "tool" },
      { _tag: "HandlerFailed", extension: "mixed", event: "turn.end" }
    ]);
  });

  it("refuses registrations from inside a transform", async () => {
    const { extensions, reports } = host();
    await extensions.add((ctx) => {
      ctx.tool.transform(() => {
        ctx.tool.transform(() => {});
      });
    });
    expect(reports).toMatchObject([
      {
        _tag: "TransformFailed",
        cause: { message: expect.stringContaining("while tool is rebuilding") }
      }
    ]);
  });

  describe("native tools", () => {
    const shell: NativeTool = {
      id: "shell",
      description: "Run.",
      inputSchema: { type: "object" },
      native: { harness: "test" }
    };

    it("start the tool draft, and transforms can edit or remove them", async () => {
      const { extensions, tools } = host({ natives: [shell] });
      expect(tools()).toEqual({ shell: "Run." });
      await extensions.add((ctx) => {
        ctx.tool.transform((draft) => {
          draft.update("shell", (entry) => ({
            ...entry,
            description: "Guarded."
          }));
        });
      });
      expect(tools()).toEqual({ shell: "Guarded." });
      await extensions.add((ctx) => {
        ctx.tool.transform((draft) => draft.remove("shell"));
      });
      expect(tools()).toEqual({});
    });

    it("cannot be removed where the harness does not support it", async () => {
      const { extensions, tools, reports } = host({
        features: ["tool"],
        natives: [shell]
      });
      await extensions.add((ctx) => {
        ctx.tool.transform((draft) => draft.remove("shell"));
      });
      expect(tools()).toEqual({ shell: "Run." });
      expect(reports).toMatchObject([
        {
          _tag: "TransformFailed",
          cause: { message: expect.stringContaining("tool.native.remove") }
        }
      ]);
    });
  });

  it("matches slash commands", async () => {
    const { extensions } = host();
    await extensions.add((ctx) => {
      ctx.command.add({ name: "review", description: "", run: () => {} });
    });
    expect(extensions.command("/review the diff")).toMatchObject({
      command: { name: "review" },
      args: "the diff"
    });
    expect(extensions.command("/review")).toMatchObject({ args: "" });
    expect(extensions.command("/unknown x")).toBeUndefined();
    expect(extensions.command("review")).toBeUndefined();
  });

  it("gives each namespace and session its own storage", async () => {
    const { extensions, store } = host();
    await extensions.add((ctx) => {
      const a = ctx.storage("a");
      a.put("k", 1);
      a.session("s/1").put("k", 2);
      ctx.storage("b").put("k", 3);
      expect(a.get("k")).toBe(1);
      expect(a.session("s/1").get("k")).toBe(2);
      expect(a.list()).toEqual([["k", 1]]);
    });
    expect([...store.list({ prefix: "ext/" })].map(([key]) => key)).toEqual([
      "ext/a/k/k",
      "ext/a/s/s%2F1/k",
      "ext/b/k/k"
    ]);
  });
});

describe("RequestStore", () => {
  const asked = {
    session: "1",
    tool: "t",
    callId: "c",
    askedAt: 1
  } as const;

  it("opens once, takes only a fitting answer, and wakes the waiter", async () => {
    const requests = new RequestStore(memoryKeyValueStore());
    const request = {
      ...asked,
      id: "r1",
      request: { kind: "select", message: "?", options: ["a", "b"] }
    } as const;
    expect(requests.open(request)).toEqual({ status: "open" });
    expect(requests.open(request)).toEqual({ status: "open" });
    expect(requests.pending()).toHaveLength(1);
    const waiting = requests.wait("r1", undefined);
    expect(requests.reply("r1", "c")).toMatchObject({ reason: "invalid" });
    expect(requests.reply("r1", "b")).toEqual({ accepted: true });
    expect(await waiting).toBe("b");
    expect(requests.reply("r1", "a")).toMatchObject({
      reason: "already_answered"
    });
    expect(requests.open(request)).toEqual({ status: "answered", reply: "b" });
    expect(requests.pending()).toEqual([]);
    expect(requests.reply("nope", true)).toMatchObject({ reason: "not_found" });
  });

  it("stops waiting on abort and keeps the request open", async () => {
    const requests = new RequestStore(memoryKeyValueStore());
    requests.open({
      ...asked,
      id: "r2",
      request: { kind: "confirm", message: "?" }
    });
    const controller = new AbortController();
    const waiting = requests.wait("r2", controller.signal);
    controller.abort(new Error("stop"));
    await expect(waiting).rejects.toThrow("stop");
    expect(requests.pending()).toHaveLength(1);
  });
});
