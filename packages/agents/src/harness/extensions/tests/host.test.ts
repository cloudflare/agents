import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  defineExtension,
  defineTool,
  ExtensionHost,
  type ExtensionFeature,
  type ExtensionReport,
  type ExtensionSnapshot,
  type ToolDraft
} from "../index";

const ALL: ExtensionFeature[] = [
  "tool",
  "tool.execute.before",
  "tool.execute.after",
  "instructions",
  "skill"
];

/** A host that records what it publishes and reports. */
function host(features: ExtensionFeature[] = ALL) {
  const published: ExtensionSnapshot[] = [];
  const reports: ExtensionReport[] = [];
  const extensions = new ExtensionHost({
    harness: "test",
    features,
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
  return { extensions, published, reports, tools };
}

function tool(id: string, description = id) {
  return defineTool({
    id,
    description,
    input: z.object({}),
    execute: () => ({ content: id })
  });
}

const call = { session: "1", callId: "c1" };

describe("ExtensionHost", () => {
  // The bugs in https://anoma.ly/notes/opencode-reloaded/, one by one.
  it("rebuilds from empty, so a refresh cannot undo a policy or stack an edit", async () => {
    const { extensions, tools } = host();
    let catalog = ["gpt", "perinium"];
    let refresh = async () => {};
    await extensions.add(
      defineExtension({
        id: "catalog",
        async setup(ctx) {
          await ctx.tool.transform((draft) => {
            for (const id of catalog) draft.add(tool(id, "128"));
          });
          refresh = () => ctx.tool.reload();
        }
      })
    );
    await extensions.add(
      defineExtension({
        id: "policy",
        setup: (ctx) =>
          void ctx.tool.transform((draft) => draft.remove("perinium"))
      })
    );
    await extensions.add(
      defineExtension({
        id: "halve",
        setup: (ctx) =>
          void ctx.tool.transform((draft: ToolDraft) => {
            for (const each of draft.list()) {
              draft.update(each.id, (t) => ({
                ...t,
                description: String(Number(t.description) / 2)
              }));
            }
          })
      })
    );
    expect(tools()).toEqual({ gpt: "64" });

    catalog = ["gpt", "perinium", "local"];
    await refresh();
    await refresh();
    // Halved once, policy still applied, the new model halved too.
    expect(tools()).toEqual({ gpt: "64", local: "64" });

    catalog = ["local"];
    await refresh();
    // A model the source dropped is gone.
    expect(tools()).toEqual({ local: "64" });
  });

  it("batches a setup into one rebuild per domain", async () => {
    const { extensions, published } = host();
    await extensions.add(
      defineExtension({
        id: "many",
        async setup(ctx) {
          await ctx.tool.transform((d) => d.add(tool("a")));
          await ctx.tool.transform((d) => d.add(tool("b")));
          await ctx.instructions.transform((d) => d.set("k", "v"));
        }
      })
    );
    expect(published).toHaveLength(2);
    expect(published.at(-1)?.tools.map((t) => t.id)).toEqual(["a", "b"]);
    expect(published.at(-1)?.instructions).toEqual([{ key: "k", text: "v" }]);
  });

  it("coalesces concurrent reloads into one more rebuild", async () => {
    const { extensions, published } = host();
    let reload = async () => {};
    await extensions.add(
      defineExtension({
        id: "slow",
        async setup(ctx) {
          await ctx.tool.transform(async (d) => {
            await new Promise((resolve) => setTimeout(resolve, 5));
            d.add(tool("a"));
          });
          reload = () => ctx.tool.reload();
        }
      })
    );
    const before = published.length;
    // Calls before a rebuild starts share it.
    await Promise.all([reload(), reload()]);
    expect(published.length - before).toBe(1);
    // Calls while one runs share the one queued behind it.
    const running = reload();
    await new Promise((resolve) => setTimeout(resolve, 1));
    await Promise.all([reload(), reload(), reload(), running]);
    expect(published.length - before).toBe(3);
  });

  it("disposes one registration, or everything when the extension goes", async () => {
    const { extensions, tools } = host();
    let cleaned = 0;
    let disposeB = async () => {};
    await extensions.add(
      defineExtension({
        id: "x",
        async setup(ctx) {
          await ctx.tool.transform((d) => d.add(tool("a")));
          disposeB = (await ctx.tool.transform((d) => d.add(tool("b"))))
            .dispose;
          await ctx.tool.hook("execute.before", (e) => {
            e.block = "no";
          });
          return () => {
            cleaned++;
          };
        }
      })
    );
    await disposeB();
    await disposeB();
    expect(tools()).toEqual({ a: "a" });
    expect(extensions.hooks("execute.before")).toBe(true);

    expect(await extensions.remove("x")).toBe(true);
    expect(await extensions.remove("x")).toBe(false);
    expect(tools()).toEqual({});
    expect(extensions.hooks("execute.before")).toBe(false);
    expect(cleaned).toBe(1);
  });

  it("rolls back a setup that throws, and refuses a duplicate id", async () => {
    const { extensions, tools } = host();
    const broken = defineExtension({
      id: "broken",
      async setup(ctx) {
        await ctx.tool.transform((d) => d.add(tool("half")));
        throw new Error("boom");
      }
    });
    const added = await extensions.add(broken);
    expect(added).toMatchObject({
      _tag: "err",
      error: { _tag: "ExtensionSetupFailed", extension: "broken" }
    });
    expect(tools()).toEqual({});
    expect(extensions.installed()).toEqual([]);

    const ok = defineExtension({ id: "ok", setup: () => {} });
    expect(await extensions.add(ok)).toEqual({ _tag: "ok" });
    expect(await extensions.add(ok)).toMatchObject({
      error: { _tag: "ExtensionAlreadyInstalled" }
    });
  });

  it("fails setup on a feature the harness lacks, unless the extension checks", async () => {
    const { extensions } = host(["tool"]);
    const added = await extensions.add(
      defineExtension({
        id: "hooky",
        setup: async (ctx) => {
          await ctx.tool.hook("execute.after", () => {});
        }
      })
    );
    expect(added).toMatchObject({
      error: {
        cause: {
          _tag: "ExtensionFeatureUnsupported",
          feature: "tool.execute.after"
        }
      }
    });
    expect(
      await extensions.add(
        defineExtension({
          id: "careful",
          setup: async (ctx) => {
            if (ctx.supports("tool.execute.after")) {
              await ctx.tool.hook("execute.after", () => {});
            }
          }
        })
      )
    ).toEqual({ _tag: "ok" });
  });

  it("chains before hooks; the first block or throw stops the call", async () => {
    const { extensions } = host();
    await extensions.add(
      defineExtension({
        id: "hooks",
        async setup(ctx) {
          await ctx.tool.hook("execute.before", (e) => {
            e.input = { ...e.input, n: 1 };
          });
          await ctx.tool.hook("execute.before", (e) => {
            e.input = { ...e.input, m: e.input["n"] ?? null };
          });
          await ctx.tool.hook("execute.before", (e) => {
            if (e.tool === "danger") throw new Error("not allowed");
          });
          await ctx.tool.hook("execute.before", (e) => {
            e.input = { ...e.input, last: true };
          });
        }
      })
    );
    const edited = await extensions.beforeTool({
      ...call,
      tool: "t",
      input: {}
    });
    expect(edited).toMatchObject({ input: { n: 1, m: 1, last: true } });
    expect(edited.block).toBeUndefined();
    const blocked = await extensions.beforeTool({
      ...call,
      tool: "danger",
      input: {}
    });
    expect(blocked).toMatchObject({
      block: "not allowed",
      input: { n: 1, m: 1 }
    });
  });

  it("chains after hooks; a throwing one is reported and skipped", async () => {
    const { extensions, reports } = host();
    await extensions.add(
      defineExtension({
        id: "after",
        async setup(ctx) {
          await ctx.tool.hook("execute.after", () => {
            throw new Error("oops");
          });
          await ctx.tool.hook("execute.after", (e) => {
            e.result = { content: `${String(e.result.content)}!` };
          });
        }
      })
    );
    const event = await extensions.afterTool({
      ...call,
      tool: "t",
      input: {},
      result: { content: "ok" }
    });
    expect(event.result).toEqual({ content: "ok!" });
    expect(reports).toMatchObject([{ _tag: "HookFailed", extension: "after" }]);
  });

  it("reports a failing transform and keeps the others", async () => {
    const { extensions, reports, tools } = host();
    await extensions.add(
      defineExtension({
        id: "mixed",
        async setup(ctx) {
          await ctx.tool.transform(() => {
            throw new Error("bad");
          });
          await ctx.tool.transform((d) => d.add(tool("good")));
        }
      })
    );
    expect(tools()).toEqual({ good: "good" });
    expect(reports).toMatchObject([
      { _tag: "TransformFailed", extension: "mixed", domain: "tool" }
    ]);
  });

  it("refuses registrations from inside a transform", async () => {
    const { extensions, reports } = host();
    await extensions.add(
      defineExtension({
        id: "reentrant",
        async setup(ctx) {
          await ctx.tool.transform(async () => {
            await ctx.tool.transform(() => {});
          });
        }
      })
    );
    expect(reports).toMatchObject([
      {
        _tag: "TransformFailed",
        cause: { message: expect.stringContaining("while tool is rebuilding") }
      }
    ]);
  });
});
