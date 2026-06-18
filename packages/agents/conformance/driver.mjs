#!/usr/bin/env node

/**
 * Conformance client driver.
 *
 * Spawned by `@modelcontextprotocol/conformance` once per scenario:
 *
 *   MCP_CONFORMANCE_SCENARIO=<scenario> node driver.mjs <server-url>
 *
 * The MCP client under test runs inside workerd (see worker.ts), started
 * separately via `wrangler dev` (see run.sh). This driver forwards the
 * scenario to a fresh agent instance and, for OAuth scenarios, plays the
 * role of the user's browser: it follows the authorization URL and the
 * resulting redirect into the worker's real OAuth callback route.
 */

const scenario = process.env.MCP_CONFORMANCE_SCENARIO;
const serverUrl = process.argv[2];
const workerOrigin =
  process.env.CONFORMANCE_WORKER_ORIGIN ?? "http://127.0.0.1:8788";

if (!scenario || !serverUrl) {
  console.error(
    "Usage: MCP_CONFORMANCE_SCENARIO=<scenario> node driver.mjs <server-url>"
  );
  process.exit(1);
}

// One agent instance (Durable Object) per scenario run so parallel scenarios
// never share state.
const base = `${workerOrigin}/agents/conformance-host/${crypto.randomUUID()}`;

// Per-scenario context (e.g. pre-registered OAuth credentials), forwarded to
// the worker as-is.
const context = process.env.MCP_CONFORMANCE_CONTEXT;

async function run() {
  const response = await fetch(`${base}/run`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ scenario, serverUrl, context })
  });
  if (!response.ok) {
    throw new Error(
      `Conformance host returned ${response.status}: ${await response.text()}`
    );
  }
  return response.json();
}

/**
 * Simulate the user authorizing in a browser: the conformance harness's
 * authorization endpoint auto-approves and 302s to the redirect_uri, which
 * points at the worker's OAuth callback route.
 */
async function authorize(authUrl) {
  const authResponse = await fetch(authUrl, { redirect: "manual" });
  const location = authResponse.headers.get("location");
  if (!location) {
    throw new Error(
      `Authorization endpoint did not redirect (status ${authResponse.status}): ${await authResponse.text()}`
    );
  }
  const callbackResponse = await fetch(location, { redirect: "manual" });
  if (callbackResponse.status >= 400) {
    throw new Error(
      `OAuth callback ${location} failed with ${callbackResponse.status}: ${await callbackResponse.text()}`
    );
  }
}

// Allow a few auth round-trips: initial authorization plus scope step-ups.
// The cap also keeps misbehaving-server scenarios (e.g. scope-retry-limit)
// from looping forever.
const MAX_AUTH_ROUND_TRIPS = 3;

try {
  let result = await run();
  for (let i = 0; i < MAX_AUTH_ROUND_TRIPS && result.status === "auth"; i++) {
    await authorize(result.authUrl);
    result = await run();
  }

  if (result.status === "done") {
    process.exit(0);
  }
  console.error(
    result.status === "auth"
      ? `Gave up after ${MAX_AUTH_ROUND_TRIPS} OAuth round-trips`
      : `Scenario failed: ${result.error}`
  );
  process.exit(1);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
