import { describe, expect, it } from "vitest";
import { PortalConnector, type PortalOperation } from "../portal";

const ctx = {} as DurableObjectState;
const env = {} as Env;

function operations(): PortalOperation[] {
  return [
    {
      rawName: "tracker.create-issue",
      tool: {
        description: "Create an issue",
        inputSchema: {
          type: "object",
          properties: { title: { type: "string" } },
          required: ["title"]
        },
        requiresApproval: true,
        execute: (args) => ({ created: args })
      }
    }
  ];
}

describe("PortalConnector", () => {
  it("derives catalog metadata and executable methods from the same operation", async () => {
    const catalog = new PortalConnector(ctx, env, operations(), "catalog");
    const execute = new PortalConnector(ctx, env, operations(), "execute");

    await expect(catalog.describe()).resolves.toMatchObject({
      name: "portal",
      descriptors: { tools: expect.any(Object) },
      annotations: { tools: { replay: "reexecute" } }
    });
    await expect(catalog.executeTool("tools", {})).resolves.toEqual([
      expect.objectContaining({
        name: "tracker_create_issue",
        rawName: "tracker.create-issue",
        description: "Create an issue",
        requiresApproval: true,
        inputSchema: expect.objectContaining({ required: ["title"] })
      })
    ]);

    await expect(execute.describe()).resolves.toMatchObject({
      name: "portal",
      descriptors: { tracker_create_issue: expect.any(Object) },
      annotations: { tracker_create_issue: { requiresApproval: true } }
    });
    await expect(
      execute.executeTool("tracker_create_issue", { title: "Example" })
    ).resolves.toEqual({ created: { title: "Example" } });
    await expect(execute.executeTool("tools", {})).rejects.toThrow(
      'Tool "tools" not found on portal'
    );
  });

  it("fails closed when sanitized operation names collide", async () => {
    const connector = new PortalConnector(
      ctx,
      env,
      [
        ...operations(),
        { ...operations()[0], rawName: "tracker.create_issue" }
      ],
      "catalog"
    );

    await expect(connector.describe()).rejects.toThrow(
      'Portal operations "tracker.create-issue" and "tracker.create_issue" ' +
        'both map to "tracker_create_issue"'
    );
  });

  it("reserves portal.tools for catalog discovery", async () => {
    const connector = new PortalConnector(
      ctx,
      env,
      [{ ...operations()[0], rawName: "tools" }],
      "execute"
    );

    await expect(connector.describe()).rejects.toThrow(
      'Portal operation "tools" maps to the reserved name "tools"'
    );
  });
});
