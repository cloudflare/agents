export const WEB_CHANNEL_DEMO_HTML = String.raw`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Web Channel transport demo</title>
  <style>
    :root { color-scheme: light dark; font-family: system-ui, sans-serif; }
    body { margin: 0 auto; max-width: 900px; padding: 2rem 1rem 4rem; }
    h1 { margin-bottom: .25rem; }
    .note { color: #777; margin-top: 0; }
    form { display: flex; gap: .5rem; margin: 1.5rem 0; }
    input { flex: 1; padding: .7rem; }
    button { padding: .7rem 1rem; }
    .grid { display: grid; gap: 1rem; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); }
    section { border: 1px solid #8886; border-radius: 8px; padding: 1rem; }
    h2 { font-size: 1rem; margin-top: 0; }
    pre { margin: 0; min-height: 3rem; overflow-wrap: anywhere; white-space: pre-wrap; }
    #wire { max-height: 22rem; overflow: auto; }
    #status { font-weight: 600; }
  </style>
</head>
<body>
  <h1>Web Channel transport demo</h1>
  <p class="note">This is a deterministic protocol viewer, not an AI response and not a hook-compatibility demo.</p>
  <form id="form">
    <input id="prompt" value="Show me the Web Channel" aria-label="Demo message">
    <button type="submit">Send and stream</button>
    <button type="button" id="interrupt">Send interrupted stream</button>
    <button type="button" id="stop" disabled>Stop</button>
  </form>
  <p>Status: <span id="status">connecting</span></p>
  <div class="grid">
    <section><h2>Reasoning</h2><pre id="reasoning"></pre></section>
    <section><h2>Text</h2><pre id="text"></pre></section>
    <section><h2>Sources</h2><pre id="sources"></pre></section>
  </div>
  <section style="margin-top:1rem"><h2>Raw WebSocket frames</h2><pre id="wire"></pre></section>
<script>
(() => {
  const byId = (id) => document.getElementById(id);
  const status = byId("status");
  const wire = byId("wire");
  const stop = byId("stop");
  const objectName = "browser-demo-" + crypto.randomUUID();
  const socketUrl = new URL("/chat", location.href);
  socketUrl.protocol = location.protocol === "https:" ? "wss:" : "ws:";
  socketUrl.searchParams.set("name", objectName);
  const pageToken = new URL(location.href).searchParams.get("token");
  if (pageToken) socketUrl.searchParams.set("token", pageToken);
  const socket = new WebSocket(socketUrl);
  let requestId = null;

  function log(direction, value) {
    const line = document.createTextNode(direction + " " + value + "\n");
    wire.append(line);
    wire.scrollTop = wire.scrollHeight;
  }

  socket.addEventListener("open", () => { status.textContent = "ready"; });
  socket.addEventListener("close", () => {
    status.textContent = requestId ? "error: socket closed during stream" : "disconnected";
    stop.disabled = true;
  });
  socket.addEventListener("error", () => { status.textContent = "error: WebSocket connection failed"; });
  socket.addEventListener("message", (event) => {
    log("RECV", event.data);
    let frame;
    try { frame = JSON.parse(event.data); } catch { return; }
    if (frame.type !== "cf_agent_use_chat_response" || frame.id !== requestId) return;
    if (frame.body) {
      if (frame.error) {
        status.textContent = "error: " + frame.body;
      } else {
        let chunk;
        try { chunk = JSON.parse(frame.body); } catch { return; }
        if (chunk.type === "reasoning-delta") byId("reasoning").append(document.createTextNode(chunk.delta));
        if (chunk.type === "text-delta") byId("text").append(document.createTextNode(chunk.delta));
        if (chunk.type === "source-url") {
          const label = chunk.title ? chunk.title + ": " : "";
          byId("sources").append(document.createTextNode(label + chunk.url + "\n"));
        }
      }
    }
    if (frame.done) {
      if (!frame.error) status.textContent = "complete";
      requestId = null;
      stop.disabled = true;
    }
  });

  function send(interrupt) {
    if (socket.readyState !== WebSocket.OPEN || requestId) return;
    byId("reasoning").textContent = "";
    byId("text").textContent = "";
    byId("sources").textContent = "";
    requestId = crypto.randomUUID();
    const body = {
      demo: "rich",
      interrupt,
      messages: [{
        id: crypto.randomUUID(), role: "user",
        parts: [{ type: "text", text: byId("prompt").value }]
      }]
    };
    const frame = JSON.stringify({
      type: "cf_agent_use_chat_request", id: requestId,
      init: { method: "POST", body: JSON.stringify(body) }
    });
    log("SEND", frame);
    socket.send(frame);
    status.textContent = "streaming";
    stop.disabled = false;
  }

  byId("form").addEventListener("submit", (event) => { event.preventDefault(); send(false); });
  byId("interrupt").addEventListener("click", () => send(true));
  stop.addEventListener("click", () => {
    if (!requestId) return;
    const frame = JSON.stringify({ type: "cf_agent_chat_request_cancel", id: requestId });
    log("SEND", frame);
    socket.send(frame);
    status.textContent = "cancelling, partial output retained";
  });
})();
</script>
</body>
</html>`;
