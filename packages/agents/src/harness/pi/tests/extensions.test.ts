import { Type } from "@earendil-works/pi-ai";
import { createRegistry } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import {
  installExtensions,
  type PiExtension,
  type PiTool
} from "../extensions";

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

function installed(registry: ReturnType<typeof createRegistry>) {
  return registry
    .snapshot()
    .installed()
    .map((extension) => ({
      name: extension.name,
      tools: (extension.tools ?? []).map((tool) => tool.name),
      sections: (extension.sections ?? []).map((section) => section.key)
    }));
}

describe("pi extensions", () => {
  it("installs each extension's tools and sections under its name", async () => {
    const registry = createRegistry();
    await installExtensions(registry, {
      greeter: (ctx) => {
        ctx.tools.transform((tools) => tools.set("echo", echo("")));
        ctx.prompt.transform((prompt) =>
          prompt.set("preamble", { render: () => "Be brief.", tag: false })
        );
      }
    });

    expect(installed(registry)).toEqual([
      { name: "greeter", tools: ["echo"], sections: ["preamble"] }
    ]);
    const [preamble] = registry.snapshot().sections();
    expect(preamble?.section.tag).toBe(false);
  });

  it("runs extensions in order, and awaits each one", async () => {
    const order: string[] = [];
    const slow: PiExtension = async (ctx) => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      order.push(ctx.name);
    };
    await installExtensions(createRegistry(), {
      first: slow,
      second: (ctx) => {
        order.push(ctx.name);
      }
    });
    expect(order).toEqual(["first", "second"]);
  });

  it("lets a later extension remove an earlier one's tool", async () => {
    const registry = createRegistry();
    await installExtensions(registry, {
      workspace: (ctx) =>
        ctx.tools.transform((tools) => {
          tools.set("read", echo("read: "));
          tools.set("exec", echo("exec: "));
        }),
      policy: (ctx) => ctx.tools.transform((tools) => tools.delete("exec"))
    });

    expect(installed(registry)).toEqual([
      { name: "workspace", tools: ["read"], sections: [] }
    ]);
  });

  it("keeps a replaced tool in the extension that added it", async () => {
    const registry = createRegistry();
    await installExtensions(registry, {
      workspace: (ctx) =>
        ctx.tools.transform((tools) => tools.set("read", echo("read: "))),
      audit: (ctx) =>
        ctx.tools.transform((tools) => {
          const read = tools.get("read");
          if (read) tools.set("read", { ...read, description: "Audited." });
        })
    });

    const [workspace] = registry.snapshot().installed();
    expect(workspace?.name).toBe("workspace");
    expect(workspace?.tools?.map((tool) => tool.description)).toEqual([
      "Audited."
    ]);
  });

  it("installs nothing for an extension that contributes nothing", async () => {
    const registry = createRegistry();
    await installExtensions(registry, { quiet: () => {} });
    expect(installed(registry)).toEqual([]);
  });

  it("rejects an integer-like name, which would reorder the extensions", async () => {
    await expect(
      installExtensions(createRegistry(), { base: () => {}, "2": () => {} })
    ).rejects.toThrow('pi extension name "2"');
  });

  it("rejects a transform registered after its extension returned", async () => {
    let late: (() => void) | undefined;
    await installExtensions(createRegistry(), {
      leaky: (ctx) => {
        late = () => ctx.tools.transform(() => {});
      }
    });
    expect(late).toThrow("after it was installed");
  });
});
