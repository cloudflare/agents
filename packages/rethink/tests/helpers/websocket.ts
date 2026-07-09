import type { WebSocketChatResponseFrame } from "../../src";

export function waitForFrames(
  ws: WebSocket,
  count: number
): Promise<WebSocketChatResponseFrame[]> {
  return new Promise((resolve, reject) => {
    const frames: WebSocketChatResponseFrame[] = [];
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for ${count} WebSocket frames`));
    }, 1000);
    const onMessage = (event: MessageEvent) => {
      frames.push(
        JSON.parse(event.data as string) as WebSocketChatResponseFrame
      );
      if (frames.length === count) {
        cleanup();
        resolve(frames);
      }
    };
    const onError = () => {
      cleanup();
      reject(new Error("WebSocket error"));
    };
    const cleanup = () => {
      clearTimeout(timeout);
      ws.removeEventListener("message", onMessage);
      ws.removeEventListener("error", onError);
    };
    ws.addEventListener("message", onMessage);
    ws.addEventListener("error", onError);
  });
}
