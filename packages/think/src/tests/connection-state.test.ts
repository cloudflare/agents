import { exports } from "cloudflare:workers";
import { expect, it } from "vitest";
import { z } from "zod";

const connectionFrame = z.object({
  type: z.enum(["connected", "message"]),
  connectionId: z.string(),
  state: z.object({ userId: z.string() }).nullable(),
  message: z.string().optional()
});

it.each([
  ["root", "connection-state-think"],
  ["sub-agent", "connection-state-parent"]
])(
  "preserves onConnect state for the first Think %s client message",
  async (route, rootClass) => {
    const subPath = route === "root" ? "" : "/sub/connection-state-think/child";
    const response = await exports.default.fetch(
      `http://example.com/agents/${rootClass}/${crypto.randomUUID()}${subPath}`,
      { headers: { Upgrade: "websocket" } }
    );
    expect(response.status).toBe(101);
    const ws = response.webSocket;
    if (!ws) throw new Error("Connection state test: missing WebSocket");

    const frames: z.infer<typeof connectionFrame>[] = [];
    const replied = new Promise<void>((resolve) => {
      ws.addEventListener("message", (event) => {
        if (typeof event.data !== "string") return;
        const frame = connectionFrame.safeParse(JSON.parse(event.data));
        if (!frame.success) return;
        frames.push(frame.data);
        if (frame.data.type === "message") resolve();
      });
    });
    ws.accept();
    try {
      ws.send("first client message");
      await replied;
      expect(frames).toEqual([
        {
          type: "connected",
          connectionId: expect.any(String),
          state: { userId: "user-123" }
        },
        {
          type: "message",
          connectionId: frames[0]?.connectionId,
          message: "first client message",
          state: { userId: "user-123" }
        }
      ]);
    } finally {
      ws.close();
    }
  }
);
