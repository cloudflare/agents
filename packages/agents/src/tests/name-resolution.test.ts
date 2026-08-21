import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { TEST_MESSAGES } from "./shared/test-utils";
import type { McpAgent } from "../mcp";

// Since 2026-03-15 the Workers runtime populates ctx.id.name inside a
// Durable Object addressed via idFromName()/getByName(), from construction
// onward — the name no longer has to be smuggled in through storage.
// https://developers.cloudflare.com/changelog/post/2026-03-15-durable-object-id-name/
// https://developers.cloudflare.com/durable-objects/api/id/#name
//
// These tests pin that behavior: a cold-woken Agent whose first-ever entry
// point is native DO RPC resolves this.name directly from ctx.id.name, without
// storage writes or a naming bootstrap RPC.
describe("this.name resolution from ctx.id.name", () => {
  it("resolves this.name on a cold agent addressed via idFromName()", async () => {
    // The "rpc:" prefix is load-bearing: McpAgent parses this.name as
    // `${transport}:${sessionId}`, and handleMcpMessage requires the RPC
    // transport.
    const doName = `rpc:ctx-id-name-${crypto.randomUUID()}`;
    const id = env.MCP_OBJECT.idFromName(doName);
    const stub = env.MCP_OBJECT.get(id) as DurableObjectStub<McpAgent>;

    // No storage seeding — the first contact with this DO is a native RPC
    // entry point that bypasses fetch/alarm/webSocket paths. Name resolution
    // must come from ctx.id.name alone.
    const response = await stub.handleMcpMessage(TEST_MESSAGES.initialize);

    expect(response).toBeDefined();
    expect(response).toHaveProperty("result");

    const name = await runInDurableObject(stub, (instance) => instance.name);
    expect(name).toBe(doName);
  });

  it("resolves this.name on a cold agent addressed via getByName()", async () => {
    const doName = `rpc:ctx-id-name-${crypto.randomUUID()}`;
    const stub = env.MCP_OBJECT.getByName(
      doName
    ) as DurableObjectStub<McpAgent>;

    const response = await stub.handleMcpMessage(TEST_MESSAGES.initialize);

    expect(response).toBeDefined();
    expect(response).toHaveProperty("result");

    const name = await runInDurableObject(stub, (instance) => instance.name);
    expect(name).toBe(doName);
  });
});
