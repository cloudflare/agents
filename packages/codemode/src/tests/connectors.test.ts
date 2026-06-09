import { describe, expect, it, vi } from "vitest";
import {
  CodemodeConnector,
  McpConnector,
  type ConnectorTools,
  type McpConnectionLike
} from "../connectors";

const ctx = {} as ExecutionContext;

class ItemsConnector extends CodemodeConnector {
  name() {
    return "items";
  }

  created: unknown[] = [];
  deleted: unknown[] = [];

  protected tools(): ConnectorTools {
    return {
      listItems: {
        description: "List all items.",
        inputSchema: { type: "object" },
        execute: () => ["a", "b"]
      },
      createItem: {
        description: "Create an item.",
        requiresApproval: true,
        execute: (args) => {
          this.created.push(args);
          return { id: 1 };
        },
        revert: (_args, result) => {
          this.deleted.push(result);
        }
      }
    };
  }
}

describe("CodemodeConnector base", () => {
  it("derives describe() from the tools record", async () => {
    const connector = new ItemsConnector(ctx, {});
    const desc = await connector.describe();

    expect(desc.name).toBe("items");
    expect(Object.keys(desc.descriptors)).toEqual(["listItems", "createItem"]);
    expect(desc.descriptors.listItems.description).toBe("List all items.");
    // requiresApproval surfaces as an annotation; reads have none
    expect(desc.annotations).toEqual({
      createItem: { requiresApproval: true }
    });
  });

  it("dispatches executeTool and revertAction to the tool entry", async () => {
    const connector = new ItemsConnector(ctx, {});

    await expect(connector.executeTool("listItems", {})).resolves.toEqual([
      "a",
      "b"
    ]);
    await expect(
      connector.executeTool("createItem", { title: "x" })
    ).resolves.toEqual({ id: 1 });
    expect(connector.created).toEqual([{ title: "x" }]);

    await connector.revertAction("createItem", { title: "x" }, { id: 1 });
    expect(connector.deleted).toEqual([{ id: 1 }]);
    // tools without revert are a no-op
    await expect(
      connector.revertAction("listItems", {}, null)
    ).resolves.toBeUndefined();

    await expect(connector.executeTool("nope", {})).rejects.toThrow(
      'Tool "nope" not found on items'
    );
  });

  it("applies the tool(name, t) decoration hook", async () => {
    class Decorated extends ItemsConnector {
      protected override tool(name: string, t: ConnectorTools[string]) {
        return name === "listItems" ? { ...t, requiresApproval: true } : t;
      }
    }
    const desc = await new Decorated(ctx, {}).describe();
    expect(desc.annotations?.listItems).toEqual({ requiresApproval: true });
  });
});

describe("McpConnector", () => {
  it("throws when two MCP tool names sanitize to the same identifier", async () => {
    class DupConnector extends McpConnector {
      name() {
        return "dup";
      }
      protected createConnection(): McpConnectionLike {
        return {
          client: { callTool: vi.fn() },
          tools: [
            { name: "foo-bar", inputSchema: { type: "object" as const } },
            { name: "foo_bar", inputSchema: { type: "object" as const } }
          ]
        };
      }
    }

    await expect(new DupConnector(ctx, {}).describe()).rejects.toThrow(
      'MCP tools "foo-bar" and "foo_bar" on dup both map to "foo_bar"'
    );
  });
});
