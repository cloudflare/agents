import { describe, expect, it, vi } from "vitest";
import {
  CodemodeConnector,
  McpConnector,
  OpenApiConnector,
  type ConnectorTools,
  type McpConnectionLike,
  type OpenApiRequestOptions
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

    await expect(
      connector.revertAction("createItem", { title: "x" }, { id: 1 })
    ).resolves.toBe(true);
    expect(connector.deleted).toEqual([{ id: 1 }]);
    // tools without revert are a no-op and report that nothing was reverted
    await expect(connector.revertAction("listItems", {}, null)).resolves.toBe(
      false
    );

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

describe("OpenApiConnector", () => {
  const spec = {
    paths: {
      "/repos/{owner}/{repo}": {
        get: {
          operationId: "getRepo",
          summary: "Get a repository",
          parameters: [
            {
              name: "owner",
              in: "path",
              required: true,
              schema: { type: "string" }
            },
            {
              name: "repo",
              in: "path",
              required: true,
              schema: { type: "string" }
            },
            { name: "page", in: "query", schema: { type: "integer" } }
          ]
        }
      },
      "/repos/{owner}/{repo}/issues": {
        post: {
          operationId: "createIssue",
          summary: "Create an issue",
          parameters: [
            {
              name: "owner",
              in: "path",
              required: true,
              schema: { type: "string" }
            },
            {
              name: "repo",
              in: "path",
              required: true,
              schema: { type: "string" }
            }
          ],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/Issue" }
              }
            }
          }
        }
      }
    },
    components: {
      schemas: {
        Issue: {
          type: "object",
          properties: { title: { type: "string" }, body: { type: "string" } },
          required: ["title"]
        }
      }
    }
  };

  class RepoApi extends OpenApiConnector {
    calls: OpenApiRequestOptions[] = [];
    name() {
      return "repoApi";
    }
    protected spec() {
      return spec;
    }
    protected async request(options: OpenApiRequestOptions) {
      this.calls.push(options);
      return { ok: true };
    }
  }

  it("derives one tool per operation plus a request escape hatch", async () => {
    const desc = await new RepoApi(ctx, {}).describe();
    expect(Object.keys(desc.descriptors).sort()).toEqual([
      "createIssue",
      "getRepo",
      "request"
    ]);
    expect(desc.descriptors.getRepo.description).toBe("Get a repository");
  });

  it("builds a combined input schema with params and a resolved body", async () => {
    const desc = await new RepoApi(ctx, {}).describe();
    const create = desc.descriptors.createIssue.inputSchema as {
      properties: Record<string, unknown>;
      required?: string[];
    };
    expect(Object.keys(create.properties).sort()).toEqual([
      "body",
      "owner",
      "repo"
    ]);
    // $ref into components resolved inline.
    expect(create.properties.body).toMatchObject({
      type: "object",
      properties: { title: { type: "string" } }
    });
    expect(create.required).toEqual(["owner", "repo", "body"]);
  });

  it("substitutes path params and routes query/body to request()", async () => {
    const api = new RepoApi(ctx, {});
    await api.executeTool("getRepo", {
      owner: "cloudflare",
      repo: "agents",
      page: 2
    });
    expect(api.calls[0]).toEqual({
      path: "/repos/cloudflare/agents",
      method: "GET",
      params: { page: 2 }
    });

    await api.executeTool("createIssue", {
      owner: "cloudflare",
      repo: "agents",
      body: { title: "bug" }
    });
    expect(api.calls[1]).toEqual({
      path: "/repos/cloudflare/agents/issues",
      method: "POST",
      body: { title: "bug" }
    });
  });
});
