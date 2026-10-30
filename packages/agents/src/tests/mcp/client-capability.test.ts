import { env } from "cloudflare:workers";
import { evictDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { PlainMcpClientObject } from "../capabilities/mcp-client";
import { useOAuthMcpServer } from "./integration/harness";
import {
  AUTH_ORIGIN,
  CLIENT_ORIGIN,
  MCP_URL
} from "./integration/oauth-mcp-server";

// The MCP server and its authorization server, served through msw.
const server = useOAuthMcpServer();

const CALLBACK_URL = `${CLIENT_ORIGIN}/callback`;

type Plain = DurableObjectStub<PlainMcpClientObject>;

/** A standalone manager with the server registered and authorized. */
async function authorizedObject(): Promise<{ stub: Plain; name: string }> {
  const name = crypto.randomUUID();
  const stub = env.PlainMcpClientObject.getByName(name);
  const result = await stub.addServer("files", MCP_URL, CALLBACK_URL);
  if (result.state !== "authenticating" || !result.authUrl) {
    throw new Error(`expected a link, got ${result.state}`);
  }
  await stub.fetch(new Request(server.authorize(result.authUrl)));
  await stub.settle();
  expect(await stub.connectionStatus("files")).toMatchObject({
    state: "ready"
  });
  return { stub, name };
}

/** Restart the object, as after an eviction, and return a fresh stub. */
async function restart(stub: Plain, name: string): Promise<Plain> {
  await stub.restart().catch(() => {});
  return env.PlainMcpClientObject.getByName(name);
}

describe("MCPClientManager capability", () => {
  it("connects a standalone registration through OAuth and its callback", async () => {
    const stub = env.PlainMcpClientObject.getByName(crypto.randomUUID());

    const result = await stub.addServer("files", MCP_URL, CALLBACK_URL);
    expect(result).toMatchObject({ state: "authenticating" });
    if (result.state !== "authenticating" || !result.authUrl) {
      throw new Error("expected a link");
    }
    expect(result.authUrl.startsWith(`${AUTH_ORIGIN}/authorize?`)).toBe(true);
    expect(result.clientId).toMatch(/^client-/);

    await stub.fetch(new Request(server.authorize(result.authUrl)));
    await stub.settle();
    expect(await stub.connectionStatus("files")).toEqual({
      state: "ready",
      error: null
    });
  });

  it("restores persisted connections after eviction", async () => {
    const stub = env.PlainMcpClientObject.getByName(crypto.randomUUID());
    await stub.prepareRestorableServer();

    await evictDurableObject(stub);

    const response = await stub.fetch(new Request("https://example.com"));
    expect(await response.json()).toEqual({
      connectionIds: ["server"],
      states: { server: "authenticating" },
      storedServerCount: 1
    });
  });

  it("intercepts registered OAuth callback URLs", async () => {
    const stub = env.PlainMcpClientObject.getByName(crypto.randomUUID());
    const state = await stub.prepareOAuthCallback();

    const response = await stub.fetch(
      new Request(
        `https://example.com/callback?state=${encodeURIComponent(state)}&error=denied`
      )
    );
    expect(await response.json()).toMatchObject({
      serverId: "callback-server",
      authSuccess: false
    });
  });

  describe("failures and links", () => {
    it("keeps a server that was down on wake failed across restarts until it is reconnected", async () => {
      const authorized = await authorizedObject();
      server.options.up = false;
      let stub = await restart(authorized.stub, authorized.name);
      await stub.settle();

      expect(await stub.connectionStatus("files")).toMatchObject({
        state: "failed"
      });

      // Back up, but nothing retries a failed server, on a wake or otherwise.
      server.options.up = true;
      stub = await restart(stub, authorized.name);
      await stub.settle();
      expect(await stub.connectionStatus("files")).toMatchObject({
        state: "failed"
      });

      await stub.reconnect("files");
      expect(await stub.connectionStatus("files")).toEqual({
        state: "ready",
        error: null
      });
    });

    it("keeps a waiting server's link across restarts, even after it stopped working", async () => {
      const name = crypto.randomUUID();
      const stub = env.PlainMcpClientObject.getByName(name);
      const started = await stub.addServer("files", MCP_URL, CALLBACK_URL);
      expect(started.state).toBe("authenticating");

      await stub.expireOAuthStates();
      const restarted = await restart(stub, name);
      const response = await restarted.fetch(
        new Request("https://example.com")
      );
      expect(await response.json()).toMatchObject({
        states: { files: "authenticating" }
      });
    });
  });

  it("keeps the authorization link when a forgotten session restarts into OAuth", async () => {
    const name = crypto.randomUUID();
    const stub = env.PlainMcpClientObject.getByName(name);
    await stub.registerResumedServer("files", MCP_URL, CALLBACK_URL, "gone");

    // The wake resumes the saved session, the server has forgotten it, and
    // the fresh session it starts needs the user to authorize.
    const restarted = await restart(stub, name);
    await restarted.settle();

    expect(await restarted.connectionStatus("files")).toMatchObject({
      state: "authenticating"
    });
  });
});
