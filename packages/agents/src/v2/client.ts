export const html = `<!doctype html>
<html>
<meta charset="utf-8"/>
<title>Agent Dashboard</title>
<style>
  body { font: 14px system-ui, sans-serif; margin: 20px; display: grid; gap: 12px; }
  .row { display: grid; grid-template-columns: 1fr auto; gap: 8px; align-items: center; }
  textarea, input { width: 100%; }
  pre { background: #0b1020; color: #dfe7ff; padding: 12px; border-radius: 8px; max-height: 320px; overflow: auto; }
  button { padding: 8px 12px; border-radius: 8px; border: 1px solid #ccc; background:#fafafa; cursor:pointer;}
  button:hover{background:#f0f0f0}
  code { white-space: pre-wrap; }
</style>
<body>
  <div class="row">
    <div>
      <label>Thread ID:</label>
      <input id="threadId" placeholder="auto-created…" />
    </div>
    <div>
      <button id="btnNew">New Thread</button>
      <button id="btnConnect">Connect</button>
    </div>
  </div>

  <div class="row">
    <textarea id="msg" rows="3" placeholder="Type a user message…"></textarea>
    <button id="btnSend">Send</button>
  </div>

  <div class="row">
    <div>
      <button id="btnApprove">Approve (HITL)</button>
      <button id="btnReject">Reject (HITL)</button>
      <button id="btnCancel">Cancel Run</button>
      <button id="btnState">Refresh State</button>
    </div>
    <div></div>
  </div>

  <div>
    <h3>Events</h3>
    <pre id="events"></pre>
  </div>

  <div>
    <h3>State</h3>
    <pre id="state"></pre>
  </div>

<script>
const $ = (id)=>document.getElementById(id);
const E = $("events");
const S = $("state");
let ws;

async function newThread() {
  const r = await fetch("/threads", {method:"POST"});
  const j = await r.json();
  $("threadId").value = j.id;
  E.textContent = "";
  S.textContent = "";
}

function log(evt) {
  const line = typeof evt === "string" ? evt : JSON.stringify(evt);
  E.textContent += line + "\\n";
  E.scrollTop = E.scrollHeight;
}

async function connect() {
  const id = $("threadId").value.trim();
  if (!id) return alert("Set thread id");
  const proto = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(proto + "://" + location.host + "/threads/" + id + "/ws");
  ws.onopen = ()=>log("[ws] connected");
  ws.onmessage = (m)=>log(m.data);
  ws.onclose = ()=>log("[ws] closed");
}

async function send() {
  const id = $("threadId").value.trim();
  const content = $("msg").value;
  if (!id || !content) return;
  await fetch("/threads/" + id + "/invoke", {
    method:"POST",
    headers:{"content-type":"application/json"},
    body: JSON.stringify({ messages: [{ role:"user", content }] })
  });
  $("msg").value = "";
}

async function hitl(approved) {
  const id = $("threadId").value.trim();
  await fetch("/threads/" + id + "/approve", {
    method:"POST",
    headers:{"content-type":"application/json"},
    body: JSON.stringify({ approved, modified_tool_calls: [] })
  });
}

async function cancelRun() {
  const id = $("threadId").value.trim();
  await fetch("/threads/" + id + "/cancel", { method:"POST" });
}

async function refreshState() {
  const id = $("threadId").value.trim();
  const r = await fetch("/threads/" + id + "/state");
  const j = await r.json();
  S.textContent = JSON.stringify(j, null, 2);
}

$("btnNew").onclick = newThread;
$("btnConnect").onclick = connect;
$("btnSend").onclick = send;
$("btnApprove").onclick = ()=>hitl(true);
$("btnReject").onclick = ()=>hitl(false);
$("btnCancel").onclick = cancelRun;
$("btnState").onclick = refreshState;

newThread();
</script>
</body>
</html>`;
