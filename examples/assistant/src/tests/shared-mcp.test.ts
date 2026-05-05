/**
 * Shared MCP tests.
 *
 * Scope note (read this before adding tests here):
 *
 * The example's MCP surface is intentionally thin. `AssistantDirectory`
 * delegates `listMcpToolDescriptors` to `this.mcp.listTools()` and
 * `callMcpTool` to `this.mcp.callTool()`. The framework already
 * exercises those code paths in
 * `packages/agents/src/tests/mcp/add-rpc-mcp-server.test.ts` (RPC
 * transport) and the streamable-http/SSE protocol tests. There's
 * little behavior unique to this example to test on top of that.
 *
 * The tests we'd want for a deep round-trip — `addServer` + tool
 * discovery + `callMcpTool` — are blocked by two real workerd
 * test-runtime constraints:
 *
 *   1. RPC-transport `addMcpServer` requires passing
 *      `env.TestMcpStub` as an argument. From a vitest test file the
 *      call goes vitest-runner→DO and structured-clones the args,
 *      which fails with `DataCloneError: Could not serialize
 *      DurableObjectNamespace`. The pattern in the framework's own
 *      `add-rpc-mcp-server.test.ts` works around this by routing the
 *      call through a test-side Agent that calls `this.addMcpServer`
 *      from inside the same DO, where the binding never has to cross
 *      a serialization boundary. Replicating that here would require
 *      a test-only callable on the production `AssistantDirectory`,
 *      which we don't want to ship in example code.
 *
 *   2. HTTP-transport `addMcpServer` requires the directory's
 *      outbound `fetch(url)` to reach the stub MCP server in the
 *      same worker. vitest-pool-workers does not auto-route outbound
 *      fetches back to the same worker (no `SELF` service binding by
 *      default), so the connection times out / 404s.
 *
 * What we test here:
 *
 *   - The empty-state path: a fresh directory's
 *     `listMcpToolDescriptors()` returns `[]` without throwing.
 *   - The `SharedMCPClient` proxy's empty-state path inherits
 *     correctness from the directory side, so we don't add a
 *     redundant child-side check.
 *
 * If/when we need deeper MCP coverage in this example, add a small
 * test-only helper Agent that performs the registration from inside
 * its own DO. The framework's `add-rpc-mcp-server.test.ts` is the
 * canonical reference for that pattern.
 */

import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { getAgentByName } from "agents";
import { uniqueDirectoryName } from "./helpers";

describe("AssistantDirectory MCP — empty state", () => {
  it("listMcpToolDescriptors returns [] before any servers are registered", async () => {
    const directory = await getAgentByName(
      env.AssistantDirectory,
      uniqueDirectoryName()
    );

    const descriptors = await directory.listMcpToolDescriptors(500);
    expect(descriptors).toEqual([]);
  });

  it("listMcpToolDescriptors handles the explicit timeout argument", async () => {
    // Smoke test for the wait/listTools path — even with no servers,
    // a 0ms timeout shouldn't throw on `waitForConnections`.
    const directory = await getAgentByName(
      env.AssistantDirectory,
      uniqueDirectoryName()
    );

    const descriptors = await directory.listMcpToolDescriptors(0);
    expect(descriptors).toEqual([]);
  });
});
