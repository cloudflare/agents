/**
 * End-to-end flow against a live `wrangler dev --local`.
 *
 * REQUIRES docker + wrangler dev. SLOW: a cold container build plus a real
 * model turn takes minutes. This is intentionally kept separate from the fast
 * unit tests (`npm test`) — run it with the e2e config when you need to
 * reproduce locally *why a run dies* (the silent wedge we chase).
 *
 * The flow mirrors what gh-app does over the service binding, but through the
 * LOCAL_DEV-gated HTTP surface:
 *
 *   1. GET  /                          → worker is up (health banner)
 *   2. POST /dev/dispatch              → 202, resolves the per-issue ThinkAgent
 *                                        DO, sets context, starts a durable turn
 *   3. GET  /dev/messages/:session     → poll the DO message log until the turn
 *                                        visibly progresses (assistant text or a
 *                                        recorded tool call). No progress inside
 *                                        the window IS the failure we want to
 *                                        catch — on timeout we dump every
 *                                        collected message so a human can see
 *                                        exactly where it wedged.
 *
 * Everything runs against real bindings: ThinkAgent DO, container-backed
 * Workspace (real gh/git/npm/node), R2-mounted skills. No mocks.
 */
import { describe, it, expect } from "vitest";
import { BASE_URL } from "./harness";

/** One message in the DO log, as returned by ThinkAgent.debugMessages(). */
interface DebugMessage {
  role: string;
  parts: Array<{ type: string; text?: string }>;
}

/**
 * The turn "progressed" once the model produced anything real: a non-empty
 * assistant text part, OR any tool-call part (static `tool-<name>` or the
 * dynamic-tool shape). That is the signal a silent wedge would starve.
 */
function turnProgressed(messages: DebugMessage[]): boolean {
  for (const m of messages) {
    if (m.role !== "assistant") continue;
    for (const p of m.parts) {
      if (p.type === "text" && (p.text ?? "").trim().length > 0) return true;
      if (p.type === "dynamic-tool" || p.type.startsWith("tool-")) return true;
    }
  }
  return false;
}

describe("E2E: agent-think dispatch → durable turn", () => {
  it("keeps /workspace container-local instead of syncing it to the DO VFS", async () => {
    const isolation = await fetch(
      `${BASE_URL}/dev/workspace-isolation/${crypto.randomUUID()}`
    );
    expect(isolation.status).toBe(200);
    expect(await isolation.json()).toEqual({
      containerFileExists: true,
      hostVfsContainsFile: false
    });
  }, 120_000);

  it("comes up, dispatches a real run, and the turn progresses", async () => {
    // 1. Worker up.
    const health = await fetch(`${BASE_URL}/`);
    expect(health.status).toBe(200);

    // 2. Dispatch a real run. A deliberately tiny instruction so the container
    //    does real network work (clone) without deploying or commenting — we
    //    only need proof the turn moves, not a full repro.
    const dispatch = await fetch(`${BASE_URL}/dev/dispatch`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        repo: "cloudflare/agents",
        issueNumber: 1859,
        instruction:
          "just clone the repo into /workspace/agents and run ls — do not deploy or comment",
        // Optional: a real GH token lets the clone succeed. Absent, the clone
        // may fail — but the turn should still visibly progress (tool calls /
        // assistant text), which is what we assert on.
        installationToken: process.env.GH_TOKEN ?? ""
      })
    });
    expect(dispatch.status).toBe(202);
    const { session } = (await dispatch.json()) as { session: string };
    expect(session).toBeTruthy();

    // 3. Poll the DO message log until the turn progresses. Real model +
    //    container are slow, so we give it ~4 minutes and check every 5s.
    const deadline = Date.now() + 240_000;
    let messages: DebugMessage[] = [];
    while (Date.now() < deadline) {
      const res = await fetch(
        `${BASE_URL}/dev/messages/${encodeURIComponent(session)}`
      );
      if (res.ok) {
        messages = (await res.json()) as DebugMessage[];
        if (turnProgressed(messages)) {
          expect(turnProgressed(messages)).toBe(true);
          return; // success — the turn moved
        }
      }
      await new Promise((r) => setTimeout(r, 5000));
    }

    // Timed out with no progress: this is the silent-wedge failure. Dump the
    // full message log so a human can see where it died.
    throw new Error(
      `turn never progressed within 4 min for session "${session}".\n` +
        `Collected ${messages.length} message(s):\n` +
        JSON.stringify(messages, null, 2)
    );
  }, 300_000); // outrun the 4-min poll + boot slack
});
