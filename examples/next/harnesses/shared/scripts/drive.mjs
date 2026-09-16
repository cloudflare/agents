#!/usr/bin/env node
// Drive any deployed harness example over the shared browser wire, from a
// terminal: connect, snapshot, subscribe, prompt, answer every request, and
// print the log until the operation settles. Node 22+ (global WebSocket).
//
//   node scripts/drive.mjs https://pi-harness-example.<sub>.workers.dev pi-agent my-session "Roll 4d12"
//   node scripts/drive.mjs <base> <agent> <name> "<prompt>" [--deny] [--session main] [--timeout 300]
//     [--interrupt-after <seconds>]   interrupt the operation once it is running
//     [--detach]                      send the prompt and exit at once; reconnect later to replay
//     [--header "Name: value"]        extra request header, repeatable (a Cloudflare Access token: "cf-access-token: <jwt>")
//     [--replay]                      send no prompt: replay the session's whole log and exit when caught up

const [base, agent, name, prompt, ...rest] = process.argv.slice(2);
if (!base || !agent || !name || !prompt) {
  console.error(
    "usage: node drive.mjs <base-url> <agent> <name> <prompt> [--deny] [--session id] [--timeout seconds] [--interrupt-after seconds] [--detach]"
  );
  process.exit(2);
}
const option = (flag, fallback) => {
  const at = rest.indexOf(flag);
  return at >= 0 ? rest[at + 1] : fallback;
};
const decision = rest.includes("--deny") ? "deny" : "allow";
const session = option("--session", "main");
const timeoutMs = Number(option("--timeout", "300")) * 1000;
const interruptAfterMs = rest.includes("--interrupt-after")
  ? Number(option("--interrupt-after", "3")) * 1000
  : undefined;
const detach = rest.includes("--detach");
const replayOnly = rest.includes("--replay");
const headers = {};
for (
  let at = rest.indexOf("--header");
  at >= 0;
  at = rest.indexOf("--header", at + 1)
) {
  const [name, ...value] = String(rest[at + 1] ?? "").split(":");
  if (name && value.length) headers[name.trim()] = value.join(":").trim();
}
const url = `${base.replace(/^http/, "ws").replace(/\/$/, "")}/agents/${agent}/${name}?session=${encodeURIComponent(session)}`;

console.log("connecting", url);
// The built-in WebSocket cannot send custom headers; the `ws` package can.
const socket = Object.keys(headers).length
  ? new (await import("ws")).default(url, { headers })
  : new WebSocket(url);
const answered = new Set();
const started = Date.now();
let operationId;
let snapshots = 0;
const timer = setTimeout(() => {
  console.error("TIMEOUT");
  process.exit(3);
}, timeoutMs);
const send = (message) => socket.send(JSON.stringify(message));

function answer(request) {
  if (answered.has(request.requestId)) return;
  answered.add(request.requestId);
  const reply =
    request.type === "permission"
      ? { type: "permission", decision }
      : request.type === "question"
        ? {
            type: "question",
            answers: request.questions.map((question) => [
              question.options[0]?.label ?? ""
            ])
          }
        : { type: "tool", output: { ok: true } };
  console.log(
    `\nanswering ${request.type} ${request.requestId}: ${JSON.stringify(reply)}`
  );
  send({
    type: "call",
    id: `reply:${request.requestId}`,
    method: "reply",
    args: [request.requestId, reply]
  });
}

function describe(body) {
  switch (body.type) {
    case "extension": {
      const { type, ...rest } = body.body;
      return `extension:${type} ${JSON.stringify(rest).slice(0, 240)}`;
    }
    case "message_end":
      return `message_end ${JSON.stringify(body.parts).slice(0, 300)}`;
    case "tool_start":
      return `tool_start ${body.toolName} ${JSON.stringify(body.input).slice(0, 120)}`;
    case "tool_end":
      return `tool_end ${JSON.stringify(body.output).slice(0, 120)}`;
    case "request_raised":
      return `request_raised ${body.request.type} ${body.request.action ?? ""}`;
    case "operation_settled":
      return `operation_settled ${body.result.status}/${body.result.stopReason.type} ${body.result.error?.message ?? ""} usage=${JSON.stringify(body.result.usage ?? null)}`;
    case "usage":
      return `usage ${JSON.stringify(body.usage)}`;
    default:
      return body.type;
  }
}

socket.addEventListener("open", () => console.log("open"));
socket.addEventListener("error", (event) => {
  console.error("socket error", event.message ?? event);
  process.exit(4);
});
socket.addEventListener("close", (event) =>
  console.log("closed", event.code, event.reason)
);
socket.addEventListener("message", (event) => {
  const message = JSON.parse(String(event.data));
  switch (message.type) {
    case "snapshot":
      snapshots += 1;
      console.log(
        `snapshot#${snapshots} state=${message.status.state} capabilities=${message.status.capabilities.join(",")} pending=${message.status.pendingRequests.length} messages=${message.messages.messages.length}`
      );
      if (snapshots === 1) {
        if (replayOnly) {
          send({ type: "subscribe", previews: false });
          return;
        }
        send({
          type: "subscribe",
          from: message.messages.asOf,
          previews: true
        });
        send({
          type: "call",
          id: "prompt",
          method: "prompt",
          args: [prompt, {}]
        });
      }
      for (const request of message.requests) answer(request);
      return;
    case "result":
      if (message.id === "prompt") {
        operationId = message.value.operationId;
        console.log("receipt", JSON.stringify(message.value));
        if (detach) {
          console.log("detaching: the operation continues without a client");
          clearTimeout(timer);
          socket.close();
          process.exit(0);
        }
        if (interruptAfterMs !== undefined) {
          setTimeout(() => {
            console.log(`\ninterrupting ${operationId}`);
            send({
              type: "call",
              id: "interrupt",
              method: "interrupt",
              args: [{}]
            });
          }, interruptAfterMs);
        }
      } else if (message.id === "interrupt") {
        console.log("interrupt result", JSON.stringify(message.value));
      }
      return;
    case "error":
      console.log("ERROR", JSON.stringify(message.error));
      if (message.id === "prompt") process.exit(5);
      return;
    case "up_to_date":
      console.log("up_to_date");
      if (replayOnly) {
        clearTimeout(timer);
        socket.close();
        process.exit(0);
      }
      return;
    case "preview":
      process.stdout.write(message.preview.body.delta);
      return;
    case "events":
      for (const event of message.events) {
        const body = event.body;
        console.log(
          `\n[${event.seq}${event.replay ? " replay" : ""}] ${describe(body)}`
        );
        if (body.type === "request_raised") answer(body.request);
        if (
          body.type === "operation_settled" &&
          operationId !== undefined &&
          body.result.operationId === operationId
        ) {
          console.log(
            `\nDONE in ${((Date.now() - started) / 1000).toFixed(1)}s status=${body.result.status}`
          );
          clearTimeout(timer);
          setTimeout(() => {
            socket.close();
            process.exit(body.result.status === "completed" ? 0 : 1);
          }, 500);
        }
      }
      return;
    default:
      return;
  }
});
