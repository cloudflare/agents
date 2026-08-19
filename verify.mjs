import WebSocket from "ws";

const origin = process.argv[2]?.replace(/\/$/, "");
if (!origin) {
  console.error("usage: npm run verify -- https://<deployment>.workers.dev");
  process.exit(2);
}

const session = `verify-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
const agentHttp = `${origin}/agents/repro-think/${encodeURIComponent(session)}`;
const agentWs = agentHttp.replace(/^http/, "ws");
const expected = "deterministic assistant reply for issue 2132";

const parse = (event) => {
  try {
    return JSON.parse(String(event.data));
  } catch {
    return null;
  }
};

function connectSnapshot(label) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(agentWs);
    const timer = setTimeout(() => reject(new Error(`${label} snapshot timeout`)), 15_000);
    socket.addEventListener("error", (event) => {
      clearTimeout(timer);
      reject(event.error ?? new Error(`${label} websocket error`));
    });
    socket.addEventListener("message", (event) => {
      const frame = parse(event);
      if (frame?.type !== "cf_agent_chat_messages") return;
      clearTimeout(timer);
      resolve({ socket, messages: frame.messages });
    });
  });
}

function runTurn(socket) {
  return new Promise((resolve, reject) => {
    const requestId = crypto.randomUUID();
    let text = "";
    const timer = setTimeout(() => reject(new Error("turn timeout")), 20_000);
    const onMessage = (event) => {
      const frame = parse(event);
      if (frame?.type !== "cf_agent_use_chat_response" || frame.id !== requestId) return;
      if (frame.body?.trim()) {
        const chunk = JSON.parse(frame.body);
        if (chunk.type === "text-delta") {
          text += chunk.delta ?? chunk.textDelta ?? chunk.text ?? "";
        }
      }
      if (frame.error) {
        clearTimeout(timer);
        socket.removeEventListener("message", onMessage);
        reject(new Error(frame.body || "stream error"));
      } else if (frame.done) {
        clearTimeout(timer);
        socket.removeEventListener("message", onMessage);
        resolve(text);
      }
    };
    socket.addEventListener("message", onMessage);
    socket.send(
      JSON.stringify({
        type: "cf_agent_use_chat_request",
        id: requestId,
        init: {
          method: "POST",
          body: JSON.stringify({
            trigger: "submit-message",
            messages: [
              {
                id: crypto.randomUUID(),
                role: "user",
                parts: [{ type: "text", text: "Please reproduce issue 2132." }]
              }
            ]
          })
        }
      })
    );
  });
}

const close = (socket) =>
  new Promise((resolve) => {
    if (socket.readyState === WebSocket.CLOSED) return resolve();
    const timer = setTimeout(resolve, 2_000);
    socket.addEventListener(
      "close",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true }
    );
    socket.close(1000, "reconnect at stream end");
  });

const first = await connectSnapshot("initial");
const streamedText = await runTurn(first.socket);
await close(first.socket);
await new Promise((resolve) => setTimeout(resolve, 250));
const reconnected = await connectSnapshot("reconnect");
const [getMessages, diagnostic] = await Promise.all([
  fetch(`${agentHttp}/get-messages`, { cache: "no-store" }).then((response) => response.json()),
  fetch(`${agentHttp}/diagnostic`, { cache: "no-store" }).then((response) => response.json())
]);
await close(reconnected.socket);

const hasAssistant = (messages) => messages.some((message) => message.role === "assistant");
const reproduced =
  streamedText.includes(expected) &&
  !hasAssistant(reconnected.messages) &&
  !hasAssistant(getMessages) &&
  !hasAssistant(diagnostic.liveCache) &&
  hasAssistant(diagnostic.durableHistory);

console.log(
  JSON.stringify(
    {
      reproduced,
      session,
      streamedText,
      reconnectSnapshot: reconnected.messages,
      getMessages,
      liveCache: diagnostic.liveCache,
      durableHistory: diagnostic.durableHistory
    },
    null,
    2
  )
);
process.exitCode = reproduced ? 0 : 1;
