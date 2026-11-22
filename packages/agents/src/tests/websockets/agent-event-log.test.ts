import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { routeAgentRequest } from "../..";

/**
 * An Agent's event log on its own connections, and not on connections
 * routed to one of its sub-agents: those belong to the child.
 */
type Frame = Record<string, unknown> & { type: string };

async function connect(path: string) {
  const response = await routeAgentRequest(
    new Request(`https://example.com${path}`, {
      headers: { Upgrade: "websocket" }
    }),
    env
  );
  expect(response?.status).toBe(101);
  const socket = response!.webSocket as WebSocket;
  socket.accept();
  const frames: Frame[] = [];
  socket.addEventListener("message", (event) => {
    if (typeof event.data !== "string") return;
    try {
      frames.push(JSON.parse(event.data) as Frame);
    } catch {
      // Not JSON.
    }
  });
  return { socket, frames };
}

async function waitFor(check: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("condition not met");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe("event log on an Agent", () => {
  it("resyncs the Agent's own connection from its snapshot", async () => {
    const name = crypto.randomUUID();
    const { socket, frames } = await connect(
      `/agents/test-event-log-parent/${name}`
    );
    socket.send(
      JSON.stringify({ type: "cf_agent_log_subscribe", log: "feed" })
    );
    await waitFor(() => frames.some((f) => f.type === "cf_agent_log_resync"));
    expect(frames.find((f) => f.type === "cf_agent_log_resync")).toMatchObject({
      snapshot: ["parent only"]
    });
    socket.close();
  });

  it("refuses a connection routed to a sub-agent, so it never reads the parent's log", async () => {
    const name = crypto.randomUUID();
    const { socket, frames } = await connect(
      `/agents/test-event-log-parent/${name}/sub/counter-sub-agent/child`
    );
    socket.send(
      JSON.stringify({ type: "cf_agent_log_subscribe", log: "feed" })
    );
    await waitFor(() =>
      frames.some(
        (f) =>
          f.type === "cf_agent_log_error" || f.type === "cf_agent_log_resync"
      )
    );
    expect(frames.some((f) => f.type === "cf_agent_log_resync")).toBe(false);
    expect(frames.find((f) => f.type === "cf_agent_log_error")).toMatchObject({
      log: "feed",
      error: "Subscription refused"
    });
    socket.close();
  });
});
