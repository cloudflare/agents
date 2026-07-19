import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const endpoint = process.argv[2];
if (!endpoint) {
  console.error("Usage: node scripts/probe-sdk.mjs https://<worker>/mcp");
  process.exit(1);
}

console.log(`runtime=${process.version} bundled-undici=${process.versions.undici}`);
let requestNumber = 0;
const tracedFetch = async (input, init = {}) => {
  const number = ++requestNumber;
  const method = init.method ?? "GET";
  const started = performance.now();
  console.log(`#${number} ${method} started`);
  const response = await fetch(input, init);
  console.log(
    `#${number} ${method} headers ${Math.round(performance.now() - started)}ms ` +
      `status=${response.status} edge=${response.headers.get("x-repro-http-protocol") ?? "unknown"}`
  );
  return response;
};

const transport = new StreamableHTTPClientTransport(new URL(endpoint), {
  fetch: tracedFetch
});
transport.onerror = (error) => {
  if (error?.name !== "AbortError" && !String(error).includes("AbortError")) {
    console.error("transport error:", error);
  }
};
const client = new Client({ name: "issue-1965-sdk-repro", version: "0" });

await client.connect(transport);
console.log(`MCP connected, session=${transport.sessionId}; calling tools/list`);
const outcome = await Promise.race([
  client.listTools().then((result) => ({ result })),
  new Promise((resolve) => setTimeout(() => resolve({ stalled: true }), 3_000))
]);

if ("stalled" in outcome) {
  console.log("REPRODUCED: official SDK tools/list stalled >3s.");
} else {
  console.log(
    `NOT REPRODUCED: official SDK tools/list returned ${outcome.result.tools.length} tool(s).`
  );
}

await transport.close();
