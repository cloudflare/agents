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

// Keep this manifest explicit. run.sh compares it with every selected upstream
// suite before starting; a newly published scenario therefore fails coverage
// validation instead of being mistaken for a client conformance failure (or,
// worse, passing because the referee observed incidental connection traffic).
const SUPPORTED_SCENARIOS = [
  "initialize",
  "tools_call",
  "elicitation-sep1034-client-defaults",
  "sse-retry",
  "request-metadata",
  "auth/metadata-default",
  "auth/metadata-var1",
  "auth/metadata-var2",
  "auth/metadata-var3",
  "auth/basic-cimd",
  "auth/scope-from-www-authenticate",
  "auth/scope-from-scopes-supported",
  "auth/scope-omitted-when-undefined",
  "auth/scope-step-up",
  "auth/scope-retry-limit",
  "auth/token-endpoint-auth-basic",
  "auth/token-endpoint-auth-post",
  "auth/token-endpoint-auth-none",
  "auth/pre-registration",
  "auth/2025-03-26-oauth-metadata-backcompat",
  "auth/2025-03-26-oauth-endpoint-fallback",
  "auth/resource-mismatch",
  "auth/offline-access-scope",
  "auth/offline-access-not-supported",
  "auth/authorization-server-migration",
  "auth/iss-supported",
  "auth/iss-not-advertised",
  "auth/iss-supported-missing",
  "auth/iss-wrong-issuer",
  "auth/iss-unexpected",
  "auth/iss-normalized",
  "auth/metadata-issuer-mismatch",
  "auth/client-credentials-jwt",
  "auth/client-credentials-basic",
  "auth/enterprise-managed-authorization",
  "sep-2322-client-request-state",
  "http-standard-headers",
  "http-custom-headers",
  "http-invalid-tool-headers",
  "json-schema-ref-no-deref"
];

if (process.argv[2] === "--list-scenarios") {
  console.log(SUPPORTED_SCENARIOS.join("\n"));
  process.exit(0);
}

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
if (!SUPPORTED_SCENARIOS.includes(scenario)) {
  console.error(`Unsupported conformance scenario: ${scenario}`);
  process.exit(1);
}

const EXPECTED_CALLBACK_REJECTIONS = new Set([
  "auth/iss-supported-missing",
  "auth/iss-wrong-issuer",
  "auth/iss-unexpected",
  "auth/iss-normalized"
]);

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
  if (callbackResponse.status < 400) return false;

  const body = await callbackResponse.text();
  if (
    EXPECTED_CALLBACK_REJECTIONS.has(scenario) &&
    body.includes("Issuer mismatch in authorization response")
  ) {
    // These scenarios require rejection before token exchange. The upstream
    // referee independently verifies that no forbidden token request occurred;
    // a rejected callback is therefore the expected terminal client action.
    return true;
  }

  throw new Error(
    `OAuth callback ${location} failed with ${callbackResponse.status}: ${body}`
  );
}

// Allow normal authorization plus scope step-ups, and follow one request beyond
// the referee's permitted maximum of three. That fourth redirect is essential:
// it lets scope-retry-limit observe and fail an over-retrying client instead of
// letting this browser shim hide the extra authorization URL.
const MAX_AUTH_ROUND_TRIPS = 4;

try {
  let result = await run();
  for (let i = 0; i < MAX_AUTH_ROUND_TRIPS && result.status === "auth"; i++) {
    if (await authorize(result.authUrl)) process.exit(0);
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
