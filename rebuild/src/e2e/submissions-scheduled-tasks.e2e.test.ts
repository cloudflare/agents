import { describe, expect, it, vi } from "vitest";
import { createMemoryHost, type MemoryHost } from "../adapters/memory/host.js";
import { createFakeModel } from "../adapters/memory/fake-model.js";
import type { IdSource } from "../kernel/ids.js";
import type { ModelClient, ModelMessage } from "../ports/model.js";
import { userMessage } from "../domain/messages/model.js";
import type { DeclaredTasks } from "../domain/scheduled-tasks/tasks.js";
import type { AgentHost } from "../app/agent.js";
import { Think } from "../app/think.js";

/**
 * Scenario 3 (audit 24 §3): programmatic turns — the submissions ledger
 * (durable accept-before-run acceptance for webhook/RPC callers) and Think's
 * declared scheduled tasks (the schedule DSL driving a recurring prompt).
 *
 * Known gap (see report): `Agent.start()`/`Think.onStart()` never calls
 * `reconcileScheduledTasks()` automatically, even though audit 13 describes
 * reconciliation as running "at startup". Declared tasks are inert until a
 * caller invokes `reconcileScheduledTasks()` explicitly, which is what the
 * scheduled-task tests below do. Not fixed here: out of this wave's
 * authorized change surface (recovery.ts / think.ts recovery paths only).
 *
 * Known gap (see report): `Think` has no public `cancelSubmission`/`inspect`/
 * `list` surface over the submissions ledger (only `submitMessages()` and the
 * bulk `clearMessages()` -> markAllPendingSkipped() path are exposed). The
 * "cancellation of a pending submission" bullet is demonstrated via
 * `clearMessages()`, the closest available public lever, rather than a
 * genuine per-submission cancel.
 */

function counterIds(): IdSource {
  let n = 0;
  return { newId: (prefix: string) => `${prefix}_${++n}` };
}

function toHost(mem: MemoryHost, opts: Partial<AgentHost> & { className: string; name: string }): AgentHost {
  return {
    store: mem.store,
    alarm: mem.alarms,
    clock: mem.clock,
    ids: counterIds(),
    ...opts,
  };
}

class SubmissionsThink extends Think<unknown> {
  model!: ModelClient;
  declaredTasks: DeclaredTasks = {};

  protected override getModel(): ModelClient {
    return this.model;
  }
  protected override getScheduledTasks(): DeclaredTasks {
    return this.declaredTasks;
  }
}

function makeAgent(): { agent: SubmissionsThink; mem: MemoryHost } {
  const mem = createMemoryHost({ agent: "SubmissionsThink", name: "s1" });
  const host = toHost(mem, { className: "SubmissionsThink", name: "s1" });
  const agent = new SubmissionsThink(host);
  mem.attachAgent(agent);
  return { agent, mem };
}

function userTextOf(m: ModelMessage): string | undefined {
  if (m.role !== "user") return undefined;
  return m.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("");
}

describe("e2e: submissions ledger", () => {
  it("accepts before inference, isolates FIFO turns, and dedupes an idempotency key", async () => {
    const { agent } = makeAgent();
    const model = createFakeModel(() => ({ kind: "text", text: "ack" }));
    agent.model = model;
    await agent.start();

    const sub1 = await agent.submitMessages([userMessage("first task")], { idempotencyKey: "job-1" });
    // Accepted synchronously, before the drain (a macrotask) has run the turn.
    expect(sub1.accepted).toBe(true);
    expect(sub1.status).toBe("pending");
    expect(model.requests).toHaveLength(0);

    const sub2 = await agent.submitMessages([userMessage("second task")]);
    expect(sub2.accepted).toBe(true);

    // Idempotent retry: the same key returns the existing record, not a new one.
    const retry = await agent.submitMessages([userMessage("first task (retry)")], { idempotencyKey: "job-1" });
    expect(retry.accepted).toBe(false);
    expect(retry.submissionId).toBe(sub1.submissionId);

    await vi.waitFor(() => expect(model.requests).toHaveLength(2));

    // FIFO isolation: submission 2's message was invisible to submission 1's turn.
    const turn1Texts = model.requests[0]!.messages.map(userTextOf).filter((t): t is string => t !== undefined);
    expect(turn1Texts).toEqual(["first task"]);

    // ...and submission 1's turn (now settled) is visible history for submission 2's turn.
    const turn2Texts = model.requests[1]!.messages.map(userTextOf).filter((t): t is string => t !== undefined);
    expect(turn2Texts).toEqual(["first task", "second task"]);

    const messages = await agent.getMessages();
    expect(messages).toHaveLength(4); // 2 x (user, assistant)
  });

  it("clearMessages() skips a still-pending submission and aborts a running one (closest available cancellation lever)", async () => {
    const { agent } = makeAgent();
    // The first submission's turn hangs, so the second stays "pending" —
    // claimed by drain only after the first settles.
    const model = createFakeModel([{ kind: "hang" }, { kind: "text", text: "should never run" }]);
    agent.model = model;
    await agent.start();

    await agent.submitMessages([userMessage("stuck")]);
    const pending = await agent.submitMessages([userMessage("never runs")]);
    expect(pending.status).toBe("pending");

    await vi.waitFor(() => expect(model.requests).toHaveLength(1)); // the hanging turn has started

    await agent.clearMessages();

    // Give the drain loop a chance to react; it must never claim the
    // still-pending (now skipped) second submission.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(model.requests).toHaveLength(1);
    expect(await agent.getMessages()).toHaveLength(0);
  });
});

describe("e2e: declared scheduled tasks", () => {
  it("arms, runs, dedupes by occurrence, and re-arms the DSL-declared prompt task without backfilling a late alarm", async () => {
    const { agent, mem } = makeAgent();
    const model = createFakeModel(() => ({ kind: "text", text: "Here is your digest." }));
    agent.model = model;
    agent.declaredTasks = {
      morningDigest: {
        schedule: "every day at 09:00 in UTC",
        prompt: "Give me the morning digest.",
      },
    };
    await agent.start();
    await agent.reconcileScheduledTasks(); // gap workaround: not run automatically by start()

    // First occurrence: 1970-01-01T09:00:00Z = 32_400_000ms after epoch 0.
    const firstOccurrence = 9 * 60 * 60 * 1000;
    mem.clock.advance(firstOccurrence);
    await vi.waitFor(() => expect(model.requests).toHaveLength(1));
    expect(model.requests[0]!.messages.map(userTextOf)).toEqual(
      expect.arrayContaining(["Give me the morning digest."]),
    );

    const messagesAfterFirst = await agent.getMessages();
    expect(messagesAfterFirst).toHaveLength(2); // (user prompt, assistant reply)

    // Deduped submission: the occurrence's own idempotency key already has a
    // settled row, so a duplicate submit under the same key is rejected.
    const dup = await agent.submitMessages([userMessage("duplicate occurrence")], {
      idempotencyKey: `task:morningDigest:${firstOccurrence}`,
    });
    expect(dup.accepted).toBe(false);

    // Late alarm: jump straight past several missed daily occurrences (days
    // 2-4) in one clock advance. Exactly one more occurrence must run (the
    // most recent due one) — not one per missed day — and the next armed
    // occurrence must be strictly in the future from "now", not backfilled.
    const oneDay = 24 * 60 * 60 * 1000;
    mem.clock.advance(oneDay * 4 + 60_000); // now: well past days 2, 3, and 4's 09:00
    await vi.waitFor(() => expect(model.requests).toHaveLength(2));

    // Give any (incorrect) extra backfilled runs a chance to surface before asserting.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(model.requests).toHaveLength(2);
    const messagesAfterLate = await agent.getMessages();
    expect(messagesAfterLate).toHaveLength(4); // one more (user, assistant) pair, not three
  });
});
