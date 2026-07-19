const endpoint = process.argv[2];
if (!endpoint) {
  console.error("Usage: node scripts/probe-global-fetch.mjs https://<worker>/mcp");
  process.exit(1);
}

console.log(`runtime=${process.version} bundled-undici=${process.versions.undici}`);
const jsonHeaders = {
  accept: "application/json, text/event-stream",
  "content-type": "application/json"
};

async function timedFetch(label, input, init) {
  const started = performance.now();
  const response = await fetch(input, init);
  console.log(
    `${label}: headers ${Math.round(performance.now() - started)}ms ` +
      `status=${response.status} edge=${response.headers.get("x-repro-http-protocol") ?? "unknown"}`
  );
  return response;
}

const init = await timedFetch("initialize", endpoint, {
  method: "POST",
  headers: jsonHeaders,
  body: JSON.stringify({
    jsonrpc: "2.0",
    id: 0,
    method: "initialize",
    params: {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "issue-1965-global-fetch-repro", version: "0" }
    }
  })
});
const sessionId = init.headers.get("mcp-session-id");
await init.text();
const sessionHeaders = sessionId ? { "mcp-session-id": sessionId } : {};

const initialized = await timedFetch("initialized", endpoint, {
  method: "POST",
  headers: { ...jsonHeaders, ...sessionHeaders },
  body: JSON.stringify({
    jsonrpc: "2.0",
    method: "notifications/initialized"
  })
});
await initialized.text();

const standalone = await timedFetch("standalone GET", endpoint, {
  headers: { accept: "text/event-stream", ...sessionHeaders }
});
console.log("standalone GET body is open and deliberately unread");

const toolsStarted = performance.now();
const pendingTools = timedFetch("tools/list", endpoint, {
  method: "POST",
  headers: { ...jsonHeaders, ...sessionHeaders },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })
});
const outcome = await Promise.race([
  pendingTools.then(() => "answered"),
  new Promise((resolve) => setTimeout(() => resolve("stalled"), 3_000))
]);

if (outcome === "stalled") {
  console.log("REPRODUCED: global-fetch tools/list was not dispatched (>3s).");
  await standalone.body?.cancel();
  const tools = await pendingTools;
  await tools.text();
  console.log(
    `After canceling GET, the queued POST completed at ${Math.round(performance.now() - toolsStarted)}ms.`
  );
} else {
  console.log("NOT REPRODUCED: tools/list completed while GET was open.");
  await standalone.body?.cancel();
}
