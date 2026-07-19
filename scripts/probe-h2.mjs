import http2 from "node:http2";

if (!process.argv[2]) {
  console.error("Usage: npm run probe:h2 -- https://<worker>/mcp");
  process.exit(1);
}
const target = new URL(process.argv[2]);
const origin = target.origin;
const path = target.pathname || "/mcp";
const TIMEOUT_MS = 5_000;
const jsonHeaders = {
  accept: "application/json, text/event-stream",
  "content-type": "application/json"
};

const client = http2.connect(origin);
client.on("error", (error) => console.error("HTTP/2 session error:", error));
await new Promise((resolve, reject) => {
  client.once("connect", resolve);
  client.once("error", reject);
});
console.log(
  `connected origin=${origin} ALPN=${client.socket.alpnProtocol} remote=${client.socket.remoteAddress}`
);

function send(label, headers, body, { headersOnly = false } = {}) {
  return new Promise((resolve, reject) => {
    const started = performance.now();
    const stream = client.request({ ":path": path, ...headers });
    const chunks = [];
    let responseHeaders;
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve({
        stream,
        headers: responseHeaders,
        body: Buffer.concat(chunks).toString(),
        stalled: true,
        elapsed: Math.round(performance.now() - started)
      });
    }, TIMEOUT_MS);

    stream.on("response", (receivedHeaders) => {
      responseHeaders = receivedHeaders;
      console.log(
        `${label}: headers ${Math.round(performance.now() - started)}ms ` +
          `status=${receivedHeaders[":status"]} stream=${stream.id} ` +
          `edge=${receivedHeaders["x-repro-http-protocol"] ?? "unknown"}`
      );
      if (headersOnly && !settled) {
        settled = true;
        clearTimeout(timer);
        resolve({ stream, headers: receivedHeaders, elapsed: performance.now() - started });
      }
    });
    stream.on("data", (chunk) => chunks.push(chunk));
    stream.on("end", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        stream,
        headers: responseHeaders,
        body: Buffer.concat(chunks).toString(),
        stalled: false,
        elapsed: Math.round(performance.now() - started)
      });
    });
    stream.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });

    stream.end(body);
  });
}

async function runSequence(label, openStandaloneGet) {
  console.log(`\n${label}: ${openStandaloneGet ? "with" : "without"} standalone GET`);
  const init = await send(
    `${label} initialize`,
    { ":method": "POST", ...jsonHeaders },
    JSON.stringify({
      jsonrpc: "2.0",
      id: 0,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "issue-1965-raw-h2", version: "0" }
      }
    })
  );
  if (init.stalled) throw new Error(`${label} initialize stalled`);
  const sessionId = init.headers?.["mcp-session-id"];
  if (!sessionId) throw new Error(`${label} initialize returned no mcp-session-id`);

  const sessionHeaders = { "mcp-session-id": sessionId };
  const initialized = await send(
    `${label} initialized`,
    { ":method": "POST", ...jsonHeaders, ...sessionHeaders },
    JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })
  );
  if (initialized.stalled) throw new Error(`${label} initialized stalled`);

  let standalone;
  if (openStandaloneGet) {
    standalone = await send(
      `${label} standalone GET`,
      { ":method": "GET", accept: "text/event-stream", ...sessionHeaders },
      undefined,
      { headersOnly: true }
    );
    console.log(`${label} standalone GET body deliberately left open`);
  }

  const tools = await send(
    `${label} tools/list`,
    { ":method": "POST", ...jsonHeaders, ...sessionHeaders },
    JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })
  );
  console.log(
    `${label} tools/list: ${tools.stalled ? `STALL >${TIMEOUT_MS}ms` : `completed ${tools.elapsed}ms body=${tools.body.length} bytes`}`
  );
  return { standalone, tools };
}

try {
  const control = await runSequence("CONTROL", false);
  const test = await runSequence("TEST", true);
  test.standalone?.stream.close();
  client.close();
  if (control.tools.stalled || test.tools.stalled) process.exitCode = 2;
} catch (error) {
  console.error(error);
  client.destroy();
  process.exitCode = 1;
}
