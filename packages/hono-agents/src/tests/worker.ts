import { Agent } from "agents";

/** Minimal Agent fixture for hono-agents WebSocket routing tests. */
export class TestHonoAgent extends Agent {}

/** Worker module that exposes the Durable Object test fixture. */
export default {
  fetch(): Response {
    return new Response("Not found", { status: 404 });
  }
};
