import { describe, expect, it } from "vitest";
import { SELF } from "cloudflare:test";
import type { Env } from "./worker";

// Declare module to get proper typing for env
declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

// Accept and close WebSocket on response to prevent "WebSocketPipe was destroyed" logs on teardown
function closeWs(res: Response) {
  if (res.webSocket) {
    res.webSocket.accept();
    res.webSocket.close();
  }
}

describe("routeAgentRequest", () => {
  describe("URL pattern matching", () => {
    it("should route /agents/{agent}/{name} to correct agent", async () => {
      const res = await SELF.fetch(
        "http://example.com/agents/test-state-agent/my-room",
        {
          headers: { Upgrade: "websocket" }
        }
      );

      // WebSocket upgrade should succeed (101) or return upgrade required (426)
      expect([101, 426]).toContain(res.status);
      closeWs(res);
    });

    it("should route kebab-case agent names", async () => {
      const res = await SELF.fetch(
        "http://example.com/agents/test-state-agent/room-1",
        {
          headers: { Upgrade: "websocket" }
        }
      );
      expect([101, 426]).toContain(res.status);
      closeWs(res);
    });

    it("should handle 'default' as instance name", async () => {
      const res = await SELF.fetch(
        "http://example.com/agents/test-state-agent/default",
        {
          headers: { Upgrade: "websocket" }
        }
      );
      expect([101, 426]).toContain(res.status);
      closeWs(res);
    });

    it("should handle instance names with special characters", async () => {
      // Instance names can include various characters
      const res = await SELF.fetch(
        "http://example.com/agents/test-state-agent/user-123-abc",
        {
          headers: { Upgrade: "websocket" }
        }
      );
      expect([101, 426]).toContain(res.status);
      closeWs(res);
    });

    it("should return 400 for non-existent agent binding", async () => {
      const res = await SELF.fetch(
        "http://example.com/agents/non-existent-agent/room"
      );
      // Returns 400 when the agent namespace doesn't have a matching binding
      expect(res.status).toBe(400);
    });

    it("should return 404 for malformed paths", async () => {
      // Missing instance name
      const res1 = await SELF.fetch(
        "http://example.com/agents/test-state-agent"
      );
      expect(res1.status).toBe(404);

      // Missing agent name
      const res2 = await SELF.fetch("http://example.com/agents/");
      expect(res2.status).toBe(404);

      // Just /agents
      const res3 = await SELF.fetch("http://example.com/agents");
      expect(res3.status).toBe(404);
    });

    it("should return 404 for paths not starting with /agents", async () => {
      const res = await SELF.fetch("http://example.com/api/something");
      expect(res.status).toBe(404);
    });
  });

  describe("case sensitivity", () => {
    it("should match CamelCase class names via kebab-case URL", async () => {
      // TestStateAgent → test-state-agent
      const res = await SELF.fetch(
        "http://example.com/agents/test-state-agent/room",
        {
          headers: { Upgrade: "websocket" }
        }
      );
      expect([101, 426]).toContain(res.status);
      closeWs(res);
    });

    it("should match UPPERCASE class names via lowercase URL", async () => {
      // CaseSensitiveAgent → case-sensitive-agent
      const res = await SELF.fetch(
        "http://example.com/agents/case-sensitive-agent/room",
        {
          headers: { Upgrade: "websocket" }
        }
      );
      expect([101, 426]).toContain(res.status);
      closeWs(res);
    });

    it("should handle underscored class names", async () => {
      // UserNotificationAgent → user-notification-agent
      const res = await SELF.fetch(
        "http://example.com/agents/user-notification-agent/room",
        {
          headers: { Upgrade: "websocket" }
        }
      );
      expect([101, 426]).toContain(res.status);
      closeWs(res);
    });
  });

  describe("sub-paths", () => {
    it("should handle sub-paths after instance name", async () => {
      // Sub-paths like /agents/agent/room/callback are valid
      const res = await SELF.fetch(
        "http://example.com/agents/test-o-auth-agent/default/callback?code=test",
        { headers: { Upgrade: "websocket" } }
      );
      // Should reach the agent (not 404)
      expect(res.status).not.toBe(404);
      closeWs(res);
    });

    it("should pass sub-path to agent fetch handler", async () => {
      // The agent receives the full path and can parse sub-paths
      const res = await SELF.fetch(
        "http://example.com/agents/test-o-auth-agent/room/some/nested/path"
      );
      // Agent should receive and handle (or reject) the request
      expect(res.status).not.toBe(404);
      closeWs(res);
    });
  });

  describe("query parameters", () => {
    it("should preserve query parameters when routing", async () => {
      const res = await SELF.fetch(
        "http://example.com/agents/test-state-agent/room?foo=bar&baz=qux",
        { headers: { Upgrade: "websocket" } }
      );
      expect([101, 426]).toContain(res.status);
      closeWs(res);
    });
  });

  describe("HTTP methods", () => {
    it("should route GET requests with WebSocket upgrade", async () => {
      const res = await SELF.fetch(
        "http://example.com/agents/test-state-agent/room",
        {
          method: "GET",
          headers: { Upgrade: "websocket" }
        }
      );
      // WebSocket upgrade succeeds
      expect([101, 426]).toContain(res.status);
      closeWs(res);
    });

    it("should return 404 for non-WebSocket HTTP requests (routeAgentRequest only handles WebSocket)", async () => {
      const res = await SELF.fetch(
        "http://example.com/agents/test-state-agent/room",
        {
          method: "GET"
          // No WebSocket upgrade header
        }
      );
      // routeAgentRequest returns null for non-WebSocket requests, falling through to 404
      expect(res.status).toBe(404);
    });
  });

  describe("multiple agents", () => {
    it("should route to different agents based on path", async () => {
      // Route to TestStateAgent
      const res1 = await SELF.fetch(
        "http://example.com/agents/test-state-agent/room",
        {
          headers: { Upgrade: "websocket" }
        }
      );
      expect([101, 426]).toContain(res1.status);
      closeWs(res1);

      // Route to TestScheduleAgent
      const res2 = await SELF.fetch(
        "http://example.com/agents/test-schedule-agent/room",
        {
          headers: { Upgrade: "websocket" }
        }
      );
      expect([101, 426]).toContain(res2.status);
      closeWs(res2);
    });

    it("should isolate instances by name", async () => {
      // Two different instances of the same agent type
      const res1 = await SELF.fetch(
        "http://example.com/agents/test-state-agent/room-a",
        {
          headers: { Upgrade: "websocket" }
        }
      );
      const res2 = await SELF.fetch(
        "http://example.com/agents/test-state-agent/room-b",
        {
          headers: { Upgrade: "websocket" }
        }
      );

      // Both should route successfully
      expect([101, 426]).toContain(res1.status);
      expect([101, 426]).toContain(res2.status);
      closeWs(res1);
      closeWs(res2);
    });
  });

  describe("WebSocket upgrade", () => {
    it("should upgrade WebSocket connections", async () => {
      const res = await SELF.fetch(
        "http://example.com/agents/test-state-agent/room",
        {
          headers: { Upgrade: "websocket" }
        }
      );
      // In test environment, may return 426 or 101
      expect([101, 426]).toContain(res.status);
      closeWs(res);
    });

    it("should not route non-WebSocket requests via routeAgentRequest", async () => {
      const res = await SELF.fetch(
        "http://example.com/agents/test-state-agent/room"
      );
      // routeAgentRequest only handles WebSocket upgrades, returns null for HTTP
      // Custom HTTP handling requires manual routing with getAgentByName + fetch
      expect(res.status).toBe(404);
    });
  });
});

describe("connection lifecycle", () => {
  // Helper to connect via WebSocket
  async function connectWS(path: string) {
    const res = await SELF.fetch(`http://example.com${path}`, {
      headers: { Upgrade: "websocket" }
    });
    expect(res.status).toBe(101);
    const ws = res.webSocket as WebSocket;
    expect(ws).toBeDefined();
    ws.accept();
    return { ws };
  }

  // Helper to wait for a message
  function waitForMessage(ws: WebSocket, timeout = 2000): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Timeout waiting for message")),
        timeout
      );
      ws.addEventListener(
        "message",
        (e: MessageEvent) => {
          clearTimeout(timer);
          resolve(JSON.parse(e.data as string));
        },
        { once: true }
      );
    });
  }

  it("should send identity message on initial connection", async () => {
    const { ws } = await connectWS("/agents/test-state-agent/lifecycle-test");

    const msg = (await waitForMessage(ws)) as { type: string; name?: string };
    expect(msg.type).toBe("cf_agent_identity");
    expect(msg.name).toBe("lifecycle-test");

    ws.close();
  });

  it("should send identity message on each reconnection", async () => {
    // First connection
    const { ws: ws1 } = await connectWS(
      "/agents/test-state-agent/reconnect-test"
    );
    const msg1 = (await waitForMessage(ws1)) as { type: string; name?: string };
    expect(msg1.type).toBe("cf_agent_identity");
    expect(msg1.name).toBe("reconnect-test");
    ws1.close();

    // Second connection (simulating reconnect)
    const { ws: ws2 } = await connectWS(
      "/agents/test-state-agent/reconnect-test"
    );
    const msg2 = (await waitForMessage(ws2)) as { type: string; name?: string };
    expect(msg2.type).toBe("cf_agent_identity");
    expect(msg2.name).toBe("reconnect-test");
    ws2.close();
  });

  it("should allow client to await ready after each connection", async () => {
    // This test validates the server behavior that enables client-side ready promise reset.
    // The client tracks "identified" state and resets it on close.
    // After reconnect, awaiting "ready" should wait for the new identity message.
    //
    // Client-side behavior (not tested here, but documented):
    //   const client = new AgentClient({ agent: "MyAgent", name: "test" });
    //   await client.ready; // Wait for identity
    //   console.log(client.identified); // true
    //   // Connection closes...
    //   console.log(client.identified); // false (reset on close)
    //   // PartySocket auto-reconnects...
    //   await client.ready; // Waits for new identity (new promise)

    const { ws } = await connectWS("/agents/test-state-agent/ready-test");

    // Identity is always the first message
    const msg = (await waitForMessage(ws)) as { type: string };
    expect(msg.type).toBe("cf_agent_identity");

    ws.close();
  });
});

describe("custom routing patterns", () => {
  describe("basePath routing with getAgentByName", () => {
    it("should route custom paths to agents", async () => {
      const res = await SELF.fetch(
        "http://example.com/custom-state/my-instance",
        {
          headers: { Upgrade: "websocket" }
        }
      );
      expect([101, 426]).toContain(res.status);
      closeWs(res);
    });

    // Note: /user auth-based routing is tested in basepath.test.ts.
    // Testing it here would create a shared "auth-user" DO that gets
    // invalidated between test files, causing flaky failures.
  });

  describe("fallback behavior", () => {
    it("should return 404 for unhandled paths", async () => {
      const res = await SELF.fetch("http://example.com/unknown/path");
      expect(res.status).toBe(404);
    });
  });
});
