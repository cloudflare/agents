import { Type } from "@earendil-works/pi-ai";
import { createRegistry } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { piExtensions, type PiExtension, type PiTool } from "../extensions";

const Echo = Type.Object({ text: Type.String() });

function echo(prefix: string): PiTool<typeof Echo> {
  return {
    description: "Echo the text back.",
    parameters: Echo,
    async execute({ text }) {
      return { content: [{ type: "text", text: `${prefix}${text}` }] };
    }
  };
}

describe("piExtensions", () => {
  it("builds every extension's tools and sections into one pi extension", async () => {
    const extension = await piExtensions({
      greeter: (ctx) => {
        ctx.tools.transform((tools) => tools.set("echo", echo("")));
        ctx.prompt.transform((prompt) =>
          prompt.set("preamble", { render: () => "Be brief.", tag: false })
        );
      },
      math: (ctx) => ctx.tools.transform((tools) => tools.set("add", echo("")))
    });

    expect(extension.name).toBe("agents");
    expect(extension.tools?.map((tool) => tool.name)).toEqual(["echo", "add"]);
    expect(extension.sections?.map((section) => section.key)).toEqual([
      "preamble"
    ]);
    expect(extension.sections?.[0]?.tag).toBe(false);
  });

  it("installs on pi's own registry, and replaces itself when installed again", async () => {
    const registry = createRegistry();
    registry.install(
      await piExtensions({
        a: (ctx) => ctx.tools.transform((tools) => tools.set("one", echo("")))
      })
    );
    registry.install(
      await piExtensions({
        a: (ctx) => ctx.tools.transform((tools) => tools.set("two", echo("")))
      })
    );
    expect(
      registry
        .snapshot()
        .tools()
        .map(({ tool }) => tool.name)
    ).toEqual(["two"]);
  });

  it("runs extensions in order, and awaits each one", async () => {
    const order: string[] = [];
    const slow: PiExtension = async (ctx) => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      order.push(ctx.name);
    };
    await piExtensions({
      first: slow,
      second: (ctx) => {
        order.push(ctx.name);
      }
    });
    expect(order).toEqual(["first", "second"]);
  });

  it("lets a later extension remove an earlier one's tool", async () => {
    const extension = await piExtensions({
      workspace: (ctx) =>
        ctx.tools.transform((tools) => {
          tools.set("read", echo("read: "));
          tools.set("exec", echo("exec: "));
        }),
      policy: (ctx) => ctx.tools.transform((tools) => tools.delete("exec"))
    });
    expect(extension.tools?.map((tool) => tool.name)).toEqual(["read"]);
  });

  it("lets a later extension rewrite an earlier one's tool in place", async () => {
    const extension = await piExtensions({
      workspace: (ctx) =>
        ctx.tools.transform((tools) => {
          tools.set("read", echo("read: "));
          tools.set("write", echo("write: "));
        }),
      audit: (ctx) =>
        ctx.tools.transform((tools) => {
          const read = tools.get("read");
          if (read) tools.set("read", { ...read, description: "Audited." });
        })
    });
    expect(
      extension.tools?.map((tool) => [tool.name, tool.description])
    ).toEqual([
      ["read", "Audited."],
      ["write", "Echo the text back."]
    ]);
  });

  it("builds an empty extension when nothing contributes", async () => {
    const extension = await piExtensions({ quiet: () => {} });
    expect(extension.tools).toEqual([]);
    expect(extension.sections).toEqual([]);
  });

  it("rejects an integer-like name, which would reorder the extensions", async () => {
    await expect(
      piExtensions({ base: () => {}, "2": () => {} })
    ).rejects.toThrow('pi extension name "2"');
  });

  it("rejects a transform registered after its extension returned", async () => {
    let late: (() => void) | undefined;
    await piExtensions({
      leaky: (ctx) => {
        late = () => ctx.tools.transform(() => {});
      }
    });
    expect(late).toThrow("after it returned");
  });
});
