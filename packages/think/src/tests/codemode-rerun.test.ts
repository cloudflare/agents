/**
 *  * A codemode run pauses twice under one execution id. The human approves
 * the first pause. A reset lands after `runtime.approve()` ran the pass
 * (which ran the first gated call and paused on the second) and before the
 * decision's outcome was stored. The recovery job reruns the continuation,
 * which calls `runtime.approve({ executionId })` again: that resumes the
 * SECOND pause, which nobody approved.
 */
import { env, exports } from "cloudflare:workers";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { getAgentByName } from "agents";
import type { UIMessage } from "ai";

type ApprovalsLike = { onStart(): Promise<void> };

function delay(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

describe("codemode approval after a reset", () => {
  it("a codemode approval rerun after a reset does not approve the next pause", async () => {
    const room = crypto.randomUUID();
    const agent = await getAgentByName(env.ThinkExecuteHitlAgent, room);
    await agent.setExecuteCodes([
      `async () => {
        const a = await tools.deploy({ target: "staging" });
        const b = await tools.deploy({ target: "prod" });
        return [a, b].join("|");
      }`
    ]);
    const res = await exports.default.fetch(
      `http://example.com/agents/think-execute-hitl-agent/${room}`,
      { headers: { Upgrade: "websocket" } }
    );
    const ws = res.webSocket as WebSocket;
    ws.accept();
    const done = new Promise<void>((resolve) => {
      ws.addEventListener("message", (e) => {
        const msg = JSON.parse(e.data as string) as Record<string, unknown>;
        if (msg.type === "cf_agent_use_chat_response" && msg.done === true)
          resolve();
      });
    });
    const message: UIMessage = {
      id: crypto.randomUUID(),
      role: "user",
      parts: [{ type: "text", text: "deploy twice" }]
    };
    ws.send(
      JSON.stringify({
        type: "cf_agent_use_chat_request",
        id: crypto.randomUUID(),
        init: { method: "POST", body: JSON.stringify({ messages: [message] }) }
      })
    );
    await done;
    const first = (await agent.executeParts())[0].output as {
      executionId: string;
    };

    // The human approves the first pause: staging deploys, prod pauses.
    await agent.approveExecution(first.executionId);
    expect(await agent.gatedCallCount()).toBe(1);

    // A reset after the pass and before the outcome write leaves the
    // decision `decided` with no outcome. The next wake re-arms its job.
    await runInDurableObject(agent, async (instance, state) => {
      state.storage.sql.exec(
        `UPDATE cf_agents_decisions
         SET status = 'decided', outcome_json = NULL, settled_at = NULL,
             acknowledged = 0
         WHERE kind = 'codemode'`
      );
      await (
        instance as unknown as { _approvals: ApprovalsLike }
      )._approvals.onStart();
    });
    await runDurableObjectAlarm(agent);
    await delay(1000);

    // Nobody approved prod.
    expect(await agent.gatedCallCount()).toBe(1);
    ws.close();
  });

  it("stores nothing for an approval of an execution that is not pending", async () => {
    const agent = await getAgentByName(
      env.ThinkExecuteHitlAgent,
      crypto.randomUUID()
    );
    for (let i = 0; i < 3; i++) {
      const outcome = (await agent.approveExecution("no-such-execution")) as {
        status: string;
      };
      expect(outcome.status).toBe("error");
    }
    await runInDurableObject(agent, (_instance, state) => {
      const [table] = [
        ...state.storage.sql.exec(
          "SELECT name FROM sqlite_master WHERE name = 'cf_agents_decisions'"
        )
      ];
      const rows = table
        ? [...state.storage.sql.exec("SELECT id FROM cf_agents_decisions")]
        : [];
      expect(rows).toEqual([]);
    });
  });
});
