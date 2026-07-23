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
// These tests pin that behavior: a cold-woken agent whose first-ever entry
// point is a native DO RPC call resolves this.name purely from ctx.id.name,
// with NO __ps_name seeding and no setName() bootstrap. (The "Cold Wake
// Initialization" tests in mcp/transports/rpc.test.ts still seed __ps_name,
// but they address via idFromName(), so under the current runtime the seed
// is inert — the legacy fallback paths it would feed are pinned upstream in
// partyserver's own test suite, not here.)
describe("this.name resolution from ctx.id.name", () => {
  it("resolves this.name on a cold agent addressed via idFromName(), without __ps_name seeding", async () => {
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

  it("resolves this.name on a cold agent addressed via getByName(), without __ps_name seeding", async () => {
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
