import WebSocket from "ws";
import { MSG_CHAT_REQUEST, MSG_THINK_CONFIG } from "./constants.js";

export function connectWs(server: string, session: string): WebSocket {
  const wsUrl = `${server}/agents/think-server/${session}`;
  return new WebSocket(wsUrl);
}

function safeSend(ws: WebSocket, data: string): boolean {
  if (ws.readyState !== WebSocket.OPEN) return false;
  try {
    ws.send(data);
    return true;
  } catch {
    return false;
  }
}

export function sendConfig(ws: WebSocket, config: { provider: string; model: string; apiKey?: string; githubToken?: string }) {
  safeSend(ws, JSON.stringify({ type: MSG_THINK_CONFIG, config }));
}

export function sendChat(ws: WebSocket, id: string, text: string) {
  safeSend(ws, JSON.stringify({
    type: MSG_CHAT_REQUEST,
    id,
    init: {
      method: "POST",
      body: JSON.stringify({
        messages: [{
          id: crypto.randomUUID(),
          role: "user",
          parts: [{ type: "text", text }]
        }]
      })
    }
  }));
}
