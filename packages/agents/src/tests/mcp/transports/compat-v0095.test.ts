/**
 * Compat tests: simulate v0.0.95 Worker control flow against the new McpAgent DO.
 *
 * In v0.0.95 the Worker:
 *   1. Gets a DO stub via `namespace.get(id)` (no "streamable-http:" name prefix)
 *   2. Calls `_init(props)` to store props
 *   3. Calls `isInitialized()` / `setInitialized()` (boolean flag, not initializeRequest)
 *   4. Sends a WS upgrade to the `/streamable-http` path on the DO
 *   5. Sends MCP messages via `ws.send()` (no cf-mcp-message header)
 *   6. Expects raw JSONRPC frames back (not wrapped in CF_MCP_AGENT_EVENT)
 *
 * These tests verify that the new DO handles all of the above correctly.
 */
import { env } from "cloudflare:test";
import type { Env } from "../../worker";
import { describe, expect, it } from "vitest";
import { TEST_MESSAGES } from "../../shared/test-utils";
import { getAgentByName } from "../../../index";
import type { McpAgent } from "../../../mcp/index";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

/**
 * Type for the v0.0.95 compat shim methods exposed on McpAgent.
 * These are public methods added for backwards compatibility.
 */
interface OldWorkerStub {
  _init(props?: Record<string, unknown>): Promise<void>;
  isInitialized(): Promise<boolean>;
  setInitialized(): Promise<void>;
  fetch(request: Request): Promise<Response>;
  setInitializeRequest(request: JSONRPCMessage): Promise<void>;
  getInitializeRequest(): Promise<JSONRPCMessage | undefined>;
}

/**
 * Simulate v0.0.95 Worker: get a DO stub with a plain session ID
 * (no "streamable-http:" prefix), send WS upgrade to /streamable-http,
 * and exchange messages via ws.send().
 */
async function oldWorkerConnect(
  namespace: DurableObjectNamespace<McpAgent>,
  props?: Record<string, unknown>
) {
  // Old Worker used a plain session ID — no transport prefix in the name.
  const sessionId = crypto.randomUUID();
  const stub = (await getAgentByName(
    namespace,
    sessionId
  )) as unknown as OldWorkerStub;

  // v0.0.95 Worker calls _init(props) via RPC
  await stub._init(props);

  // v0.0.95 Worker sends WS upgrade to /streamable-http
  const res = await stub.fetch(
    new Request("http://fake-host/streamable-http", {
      headers: { Upgrade: "websocket" }
    })
  );

  const ws = res.webSocket;
  if (!ws) throw new Error("Expected WebSocket in response");
  ws.accept();

  return { stub, ws, id: sessionId };
}

/**
 * Send a JSONRPC message via ws.send() and wait for a raw JSONRPC response.
 * Old Workers expected raw JSONRPC frames — not CF_MCP_AGENT_EVENT wrappers.
 */
function sendAndReceive(
  ws: WebSocket,
  message: JSONRPCMessage,
  timeoutMs = 5000
): Promise<JSONRPCMessage> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Timed out waiting for WS response")),
      timeoutMs
    );
    ws.addEventListener("message", function handler(event) {
      clearTimeout(timer);
      ws.removeEventListener("message", handler);
      const data =
        typeof event.data === "string"
          ? event.data
          : new TextDecoder().decode(event.data as ArrayBuffer);
      const parsed = JSON.parse(data);
      // Old Workers expect raw JSONRPC — not wrapped in CF_MCP_AGENT_EVENT.
      // If we get a CF_MCP_AGENT_EVENT wrapper, the compat layer is broken.
      if (parsed.type === "CF_MCP_AGENT_EVENT") {
        reject(
          new Error(
            "Got CF_MCP_AGENT_EVENT wrapper — old Workers expect raw JSONRPC"
          )
        );
        return;
      }
      resolve(parsed as JSONRPCMessage);
    });
    ws.send(JSON.stringify(message));
  });
}

/**
 * Collect all JSONRPC messages that arrive within a window.
 */
function collectMessages(
  ws: WebSocket,
  windowMs = 200
): Promise<JSONRPCMessage[]> {
  return new Promise((resolve) => {
    const messages: JSONRPCMessage[] = [];
    const handler = (event: MessageEvent) => {
      const data =
        typeof event.data === "string"
          ? event.data
          : new TextDecoder().decode(event.data as ArrayBuffer);
      try {
        messages.push(JSON.parse(data) as JSONRPCMessage);
      } catch {
        // ignore non-JSON
      }
    };
    ws.addEventListener("message", handler);
    setTimeout(() => {
      ws.removeEventListener("message", handler);
      resolve(messages);
    }, windowMs);
  });
}

describe("v0.0.95 Compat: Old Worker → New DO", () => {
  it("should handle _init(props) and make props accessible", async () => {
    const { stub, ws } = await oldWorkerConnect(env.MCP_OBJECT, {
      testValue: "from-old-worker"
    });

    // Initialize the MCP session
    const initResponse = await sendAndReceive(ws, TEST_MESSAGES.initialize);
    expect(initResponse).toMatchObject({
      jsonrpc: "2.0",
      id: "init-1",
      result: expect.objectContaining({
        serverInfo: expect.objectContaining({ name: "test-server" })
      })
    });

    // Mark as initialized (v0.0.95 style)
    await stub.setInitialized();

    // Call tool that reads props
    const propsResponse = await sendAndReceive(ws, TEST_MESSAGES.propsTestTool);
    expect(propsResponse).toMatchObject({
      jsonrpc: "2.0",
      result: {
        content: [{ text: "from-old-worker", type: "text" }]
      }
    });

    ws.close();
  });

  it("should handle isInitialized() compat shim", async () => {
    const { stub } = await oldWorkerConnect(env.MCP_OBJECT);

    // Before initialization, isInitialized() should return false
    const before = await stub.isInitialized();
    expect(before).toBe(false);

    // After setInitialized(), should return true
    await stub.setInitialized();
    const after = await stub.isInitialized();
    expect(after).toBe(true);
  });

  it("should return raw JSONRPC (not CF_MCP_AGENT_EVENT wrapped)", async () => {
    const { ws } = await oldWorkerConnect(env.MCP_OBJECT);

    // Initialize
    const initResponse = await sendAndReceive(ws, TEST_MESSAGES.initialize);

    // The response must be raw JSONRPC — sendAndReceive rejects if wrapped
    expect(initResponse.jsonrpc).toBe("2.0");
    expect(initResponse).toHaveProperty("result");

    ws.close();
  });

  it("should handle tool calls via ws.send()", async () => {
    const { ws } = await oldWorkerConnect(env.MCP_OBJECT);

    // Initialize
    await sendAndReceive(ws, TEST_MESSAGES.initialize);

    // Call the greet tool
    const greetResponse = await sendAndReceive(ws, TEST_MESSAGES.greetTool);
    expect(greetResponse).toMatchObject({
      jsonrpc: "2.0",
      id: "greet-1",
      result: {
        content: [{ text: "Hello, Test User!", type: "text" }]
      }
    });

    ws.close();
  });

  it("should list tools via ws.send()", async () => {
    const { ws } = await oldWorkerConnect(env.MCP_OBJECT);

    // Initialize
    await sendAndReceive(ws, TEST_MESSAGES.initialize);

    // List tools
    const toolsResponse = await sendAndReceive(ws, TEST_MESSAGES.toolsList);
    expect(toolsResponse).toMatchObject({
      jsonrpc: "2.0",
      id: "tools-1",
      result: expect.objectContaining({
        tools: expect.arrayContaining([
          expect.objectContaining({ name: "greet" })
        ])
      })
    });

    ws.close();
  });

  it("should suppress protocol messages for old-style connections", async () => {
    const { ws } = await oldWorkerConnect(env.MCP_OBJECT);

    // Collect all messages that arrive during the connection setup window.
    // Old Workers don't understand CF_AGENT_IDENTITY/CF_AGENT_STATE,
    // so shouldSendProtocolMessages should return false.
    const earlyMessages = await collectMessages(ws, 300);

    // Filter for protocol messages (identity, state, mcp_servers)
    const protocolMessages = earlyMessages.filter(
      (m) =>
        "type" in m &&
        [
          "CF_AGENT_IDENTITY",
          "CF_AGENT_STATE",
          "CF_AGENT_MCP_SERVERS"
        ].includes((m as Record<string, unknown>).type as string)
    );

    expect(protocolMessages).toHaveLength(0);

    ws.close();
  });

  it("dual storage: setInitializeRequest also sets initialized boolean", async () => {
    const sessionId = crypto.randomUUID();
    const agent = (await getAgentByName(
      env.MCP_OBJECT,
      `streamable-http:${sessionId}`
    )) as unknown as OldWorkerStub;

    // Use new-style setInitializeRequest
    await agent.setInitializeRequest(TEST_MESSAGES.initialize);

    // Old-style isInitialized() should also return true (dual storage)
    const initialized = await agent.isInitialized();
    expect(initialized).toBe(true);

    // New-style getInitializeRequest should also work
    const stored = await agent.getInitializeRequest();
    expect(stored).toMatchObject({ method: "initialize" });
  });

  it("isInitialized returns true for both old and new storage formats", async () => {
    // Test old format: only "initialized" boolean in storage
    const stub1 = (await getAgentByName(
      env.MCP_OBJECT,
      `old-format-${crypto.randomUUID()}`
    )) as unknown as OldWorkerStub;
    await stub1.setInitialized();
    expect(await stub1.isInitialized()).toBe(true);

    // Test new format: initializeRequest stored
    const stub2 = (await getAgentByName(
      env.MCP_OBJECT,
      `new-format-${crypto.randomUUID()}`
    )) as unknown as OldWorkerStub;
    await stub2.setInitializeRequest(TEST_MESSAGES.initialize);
    expect(await stub2.isInitialized()).toBe(true);
  });
});
