/**
 * `Assistant` cancellation + sub-agent gate.
 *
 *   - **B4** — parent abort propagates into the helper. The parent's
 *     tool execute is wired to thread the AI SDK's `abortSignal`
 *     into `_runHelperTurn`. When the signal fires, the helper's
 *     RPC reader cancels, which fires the helper's RPC stream's
 *     `cancel` callback, which aborts a per-turn `AbortController`
 *     whose signal Think's `saveMessages` linked into its abort
 *     registry (cloudflare/agents#1406). We assert the parent
 *     surfaces the abort as an error (not a silent empty summary)
 *     and the row reflects it.
 *
 *   - **E4** — `onBeforeSubAgent` gate validates the requested
 *     helper exists in `cf_agent_helper_runs` before the framework
 *     routes a connection to a fresh facet. Without the gate, any
 *     helperId routes through to a fresh empty facet, which is the
 *     production failure mode for a multi-tenant deployment —
 *     attackers can spawn arbitrary helper DOs by guessing names.
 */

import { exports } from "cloudflare:workers";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { getAgentByName } from "agents";
import { connectWS, uniqueAssistantName } from "./helpers";
import type { Assistant } from "./worker";

async function freshAssistant(): Promise<{
  name: string;
  assistant: DurableObjectStub<Assistant>;
}> {
  const name = uniqueAssistantName();
  const assistant = await getAgentByName(env.Assistant, name);
  await assistant.clearHelperRuns();
  return { name, assistant };
}

function parentPath(name: string): string {
  return `/agents/assistant/${name}`;
}

function subPath(parent: string, helperType: string, helperId: string): string {
  // Production wire URL shape: /agents/{parent}/{name}/sub/{kebab-class}/{helperId}.
  // The framework lowercases the class for routing.
  return `${parentPath(parent)}/sub/${helperType.toLowerCase()}/${helperId}`;
}

describe("B4 — abort signal cancels in-flight helper run", () => {
  it("rejects a Researcher run with an abort error when the signal is pre-aborted", async () => {
    const { assistant } = await freshAssistant();

    const result = await assistant.testRunHelperWithPreAbortedSignal(
      "Researcher",
      "this run will be cancelled before it even starts",
      "tc-aborted-researcher"
    );

    expect(result.rejected).toBe(true);
    // Production code throws "Helper aborted: <reason>" when the
    // signal fires before/during the read loop. Match against the
    // wider "abort" pattern so a future rephrasing doesn't break
    // the test, but keep the assertion strict enough that a
    // generic empty-summary fallback ("Researcher finished without
    // producing assistant text.") would fail it.
    expect(result.error.toLowerCase()).toContain("abort");
  });

  it("marks the row `error` with an abort message when the run is aborted", async () => {
    const { assistant } = await freshAssistant();

    await assistant.testRunHelperWithPreAbortedSignal(
      "Researcher",
      "abort and check the row",
      "tc-aborted-row"
    );

    const rows = await assistant.testReadHelperRuns();
    const row = rows.find((r) => r.parent_tool_call_id === "tc-aborted-row");
    expect(row?.status).toBe("error");
    expect(row?.error_message?.toLowerCase()).toContain("abort");
  });

  it("works for Planner too — the abort path is not class-specific", async () => {
    const { assistant } = await freshAssistant();

    const result = await assistant.testRunHelperWithPreAbortedSignal(
      "Planner",
      "plan something — but it'll be cancelled",
      "tc-aborted-planner"
    );

    expect(result.error.toLowerCase()).toContain("abort");

    const rows = await assistant.testReadHelperRuns();
    const row = rows.find(
      (r) => r.parent_tool_call_id === "tc-aborted-planner"
    );
    expect(row?.helper_type).toBe("Planner");
    expect(row?.status).toBe("error");
  });
});

describe("E4 — onBeforeSubAgent gate", () => {
  it("rejects a sub-agent connection for a helperId that's not in the registry", async () => {
    const { name } = await freshAssistant();

    // Connect to a /sub/researcher/<bogus-id> URL that has never
    // been seeded in cf_agent_helper_runs. Without the gate, the
    // framework would route this through to a fresh empty
    // Researcher facet (the default `onBeforeSubAgent` is a no-op);
    // with the gate, the parent returns 404 and the WS upgrade
    // fails.
    const response = await exports.default.fetch(
      `http://example.com${subPath(name, "Researcher", "ghost-helper-id")}`,
      { headers: { Upgrade: "websocket" } }
    );
    expect(response.status).toBe(404);
    const body = await response.text();
    expect(body).toContain("ghost-helper-id");
  });

  // Note: an "unknown helper class" route (e.g. /sub/imposter/foo)
  // never reaches `onBeforeSubAgent` — the framework's
  // `_parseSubAgentPath` is bounded by `knownClasses` from
  // `ctx.exports`, so a class that isn't a registered DO simply
  // doesn't match the sub-agent URL pattern and falls through to
  // `super.fetch`. The gate's "unknown class" branch is
  // defense-in-depth for the rare case where someone routes
  // through a bound DO class that ISN'T a helper (the parent
  // `Assistant` itself, say). Not worth a dedicated test in this
  // suite — the pattern would require structurally unusual setup.

  it("allows a sub-agent connection for a helperId that exists in the registry", async () => {
    const { name, assistant } = await freshAssistant();

    // Seed a row so the gate has something to find. We don't need
    // chunks or an actual helper Think turn — the gate's check is
    // pure SQL.
    await assistant.testSeedHelperRun({
      helperId: "real-helper",
      parentToolCallId: "tc-real",
      helperType: "Researcher",
      status: "completed",
      summary: "ok",
      chunks: []
    });

    const { ws } = await connectWS(subPath(name, "Researcher", "real-helper"));
    // Just opening the WS confirms the gate let the request
    // through (the framework returned 101). Close immediately —
    // actually using it would require Think's full chat-protocol
    // handshake which isn't in scope here.
    expect(ws).toBeDefined();
    ws.close();
  });

  it("rejects a Planner helperId that exists but as a Researcher row (cross-class isolation)", async () => {
    const { name, assistant } = await freshAssistant();

    // Seed a row at "shared-id" as a Researcher; then try to
    // drill in via /sub/planner/shared-id. The gate's WHERE
    // clause is on (helper_id, helper_type) — this query
    // returns zero rows and the gate rejects, which prevents an
    // attacker from drilling into a co-tenant's Researcher facet
    // by routing through the wrong class endpoint.
    await assistant.testSeedHelperRun({
      helperId: "shared-id",
      parentToolCallId: "tc-cross",
      helperType: "Researcher",
      status: "completed",
      summary: "ok",
      chunks: []
    });

    const response = await exports.default.fetch(
      `http://example.com${subPath(name, "Planner", "shared-id")}`,
      { headers: { Upgrade: "websocket" } }
    );
    expect(response.status).toBe(404);
  });
});
