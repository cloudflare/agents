import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { getAgentByName } from "agents";
import { describe, expect, it } from "vitest";
import { INTERRUPTED_MESSENGER_RESPONSE } from "../messengers";
import { idempotencyKeyForEvent } from "../messengers/chat-sdk";
import type { MessengerEvent } from "../messengers";

/**
 * Upgrade tests: the messenger rows think@0.24.0 (8d8acd0dd) left, written
 * exactly as that release wrote them, into an object the current code has
 * never started. Its first start is the upgrade: Tasks migrates 0.24's
 * store and Think carries the rows forward. Public behaviour only, so they
 * run on Think and on the harness-backed Think alike.
 */

type Storage = DurableObjectState["storage"];

/** 0.24's Tasks tables (`agents/src/tasks/store.ts` at 8d8acd0dd). */
function create024Tables(storage: Storage): void {
  storage.sql.exec(`
    CREATE TABLE IF NOT EXISTS cf_agents_task_runs (
      run_id TEXT PRIMARY KEY,
      definition TEXT NOT NULL,
      input TEXT,
      state TEXT NOT NULL CHECK (state IN (
        'pending', 'running', 'waiting',
        'completed', 'failed', 'cancelled'
      )),
      result TEXT,
      error_name TEXT,
      error_message TEXT,
      status_message TEXT,
      metadata TEXT,
      idempotency_key TEXT UNIQUE,
      retain INTEGER NOT NULL DEFAULT 1,
      attempt INTEGER NOT NULL DEFAULT 0,
      generation TEXT,
      next_at INTEGER,
      wait_reason TEXT,
      cancel_requested INTEGER NOT NULL DEFAULT 0,
      cancel_reason TEXT,
      created_at INTEGER NOT NULL,
      started_at INTEGER,
      updated_at INTEGER NOT NULL,
      settled_at INTEGER
    ) WITHOUT ROWID`);
  storage.sql.exec(`
    CREATE INDEX IF NOT EXISTS cf_agents_task_runs_definition
    ON cf_agents_task_runs (definition, created_at)`);
  storage.sql.exec(`
    CREATE TABLE IF NOT EXISTS cf_agents_task_steps (
      run_id TEXT NOT NULL,
      step_name TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('do', 'sleep')),
      state TEXT NOT NULL CHECK (state IN (
        'running', 'waiting', 'completed', 'failed'
      )),
      result TEXT,
      error_name TEXT,
      error_message TEXT,
      attempt INTEGER NOT NULL DEFAULT 0,
      next_at INTEGER,
      created_at INTEGER NOT NULL,
      started_at INTEGER,
      updated_at INTEGER NOT NULL,
      completed_at INTEGER,
      PRIMARY KEY (run_id, step_name)
    ) WITHOUT ROWID`);
}

/** The event a 0.24 reply snapshot kept (its serializable form). */
function releasedEvent(threadId: string): MessengerEvent {
  return {
    capabilities: {},
    kind: "direct-message",
    message: {
      attachments: [],
      author: { fullName: "Ada", userId: "user-ada" },
      createdAt: new Date(0),
      id: "rel1",
      providerMessageId: "rel1",
      text: "released hello"
    },
    messengerId: "fake",
    provider: "fake",
    thread: {
      id: threadId,
      isDirectMessage: true,
      providerThreadId: threadId
    }
  } as MessengerEvent;
}

/**
 * Write rows into a fresh object as 0.24 left them, then end the isolate,
 * so the next request starts the current code over them.
 */
async function seed024(
  name: string,
  write: (storage: Storage, now: number) => void | Promise<void>
): Promise<void> {
  const stub = env.ThinkMessengerDeliveryTestAgent.get(
    env.ThinkMessengerDeliveryTestAgent.idFromName(name)
  );
  await runInDurableObject(stub, async (_instance, state) => {
    create024Tables(state.storage);
    await state.storage.put("cf_agents:tasks_schema_version", 1);
    await write(state.storage, Date.now());
  });
  await runInDurableObject(stub, (_instance, state) => {
    try {
      state.abort("upgrade");
    } catch {
      // The abort ends this isolate; the next request starts a new one.
    }
  }).catch(() => undefined);
}

/**
 * A messenger reply run 0.24 left mid-delivery: the run and its `deliver`
 * step running, their claim lapsed, and the reply's snapshot under
 * `__cf_messenger_recovery:<runId>`.
 */
async function writeInterruptedReplyRun(
  storage: Storage,
  now: number,
  stage: "accepted" | "streaming" | "completed"
): Promise<void> {
  const nonce = crypto.randomUUID();
  const runId = `msgr_${nonce}`;
  const threadId = "fake:dm-released";
  const event = releasedEvent(threadId);
  storage.sql.exec(
    `INSERT INTO cf_agents_task_runs
       (run_id, definition, input, state, metadata, idempotency_key, retain,
        attempt, generation, next_at, created_at, started_at, updated_at)
     VALUES (?, '__cf_internal_messenger_reply', ?, 'running', ?, ?, 1,
             1, 'gen-024', ?, ?, ?, ?)`,
    runId,
    JSON.stringify({ nonce }),
    JSON.stringify({
      messengerId: event.messengerId,
      messageId: event.message?.id,
      provider: event.provider,
      threadId
    }),
    idempotencyKeyForEvent(event),
    now - 1,
    now - 1_000,
    now - 1_000,
    now - 1_000
  );
  storage.sql.exec(
    `INSERT INTO cf_agents_task_steps
       (run_id, step_name, kind, state, attempt, created_at, started_at,
        updated_at)
     VALUES (?, 'deliver', 'do', 'running', 1, ?, ?, ?)`,
    runId,
    now - 1_000,
    now - 1_000,
    now - 1_000
  );
  await storage.put(`__cf_messenger_recovery:${runId}`, {
    event,
    stage,
    // 0.24's `defaultDeliveryTag(stage)`.
    tag: {
      stage,
      kind: stage === "completed" ? "final" : "interim",
      turnEnded: stage === "completed"
    },
    thread: {
      _type: "chat:Thread",
      adapterName: "fake",
      channelId: threadId,
      id: threadId,
      isDM: true
    },
    type: "think:messenger-reply"
  });
}

/** A recovered reply 0.24 kept under `cf_think_messenger_recovery:`. */
async function writeRecoveredReply(
  storage: Storage,
  incidentId: string,
  reply: Record<string, unknown>
): Promise<void> {
  await storage.put(`cf_think_messenger_recovery:${incidentId}`, {
    messengerId: "fake",
    threadId: "fake:dm-recovered",
    partialText: "",
    ...reply
  });
}

/**
 * Start the object and wait until its posts reach `count` and no reply run
 * is left open, or 20 s. A run still open then fails the test.
 */
async function postsAfterUpgrade(
  name: string,
  count: number
): Promise<string[]> {
  const agent = await getAgentByName(env.ThinkMessengerDeliveryTestAgent, name);
  let posted: string[] = [];
  let open = -1;
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    posted = (await agent.getAdapterCalls()).map((call) => call.content);
    open = await agent.openReplyRunsForTest();
    if (posted.length >= count && open === 0) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  expect(open).toBe(0);
  return posted;
}

describe("messenger rows think@0.24.0 left, after the upgrade", () => {
  it("answers a reply run it left before any text went out", async () => {
    const name = `upgrade-accepted-${crypto.randomUUID()}`;
    await seed024(name, (storage, now) =>
      writeInterruptedReplyRun(storage, now, "accepted")
    );
    expect(await postsAfterUpgrade(name, 2)).toEqual(["Got", "Got it"]);
  }, 30_000);

  it("apologizes for a reply run it left mid-stream", async () => {
    const name = `upgrade-streaming-${crypto.randomUUID()}`;
    await seed024(name, (storage, now) =>
      writeInterruptedReplyRun(storage, now, "streaming")
    );
    expect(await postsAfterUpgrade(name, 1)).toEqual([
      INTERRUPTED_MESSENGER_RESPONSE
    ]);
  }, 30_000);

  it("posts nothing more for a reply run it left completed", async () => {
    const name = `upgrade-completed-${crypto.randomUUID()}`;
    await seed024(name, (storage, now) =>
      writeInterruptedReplyRun(storage, now, "completed")
    );
    const agent = await getAgentByName(
      env.ThinkMessengerDeliveryTestAgent,
      name
    );
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      if ((await agent.openReplyRunsForTest()) === 0) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(await agent.openReplyRunsForTest()).toBe(0);
    expect(await agent.getAdapterCalls()).toEqual([]);
  }, 30_000);

  it("apologizes for a recovered reply it left unsettled, its incident gone", async () => {
    const name = `upgrade-orphan-${crypto.randomUUID()}`;
    await seed024(name, (storage) =>
      writeRecoveredReply(storage, `${crypto.randomUUID()}:user-1`, {})
    );
    expect(await postsAfterUpgrade(name, 1)).toEqual([
      INTERRUPTED_MESSENGER_RESPONSE
    ]);
  }, 30_000);

  it("apologizes for a recovered reply it settled as interrupted", async () => {
    const name = `upgrade-interrupted-${crypto.randomUUID()}`;
    await seed024(name, (storage) =>
      writeRecoveredReply(storage, `${crypto.randomUUID()}:user-1`, {
        outcome: "interrupted"
      })
    );
    expect(await postsAfterUpgrade(name, 1)).toEqual([
      INTERRUPTED_MESSENGER_RESPONSE
    ]);
  }, 30_000);

  it("posts the rest of a recovered reply it settled, from its cursor", async () => {
    // A `split-…` agent posts each `|`-separated piece separately.
    const name = `split-upgrade-${crypto.randomUUID()}`;
    await seed024(name, (storage) =>
      writeRecoveredReply(storage, `${crypto.randomUUID()}:user-1`, {
        outcome: "completed",
        text: "one|two|three",
        posted: 1
      })
    );
    expect(await postsAfterUpgrade(name, 2)).toEqual(["two", "three"]);
  }, 30_000);

  it("apologizes for a recovered reply it held when its recovery job runs", async () => {
    const name = `upgrade-job-${crypto.randomUUID()}`;
    await seed024(name, async (storage, now) => {
      const incidentId = `${crypto.randomUUID()}:user-1`;
      await storage.put(
        `cf:chat-recovery:incident:${encodeURIComponent(incidentId)}`,
        {
          incidentId,
          requestId: "req-024",
          recoveryKind: "retry",
          attempt: 1,
          maxAttempts: 3,
          status: "scheduled",
          firstSeenAt: now - 1_000,
          lastAttemptAt: now - 1_000
        }
      );
      await writeRecoveredReply(storage, incidentId, {});
      // As 0.24 left an initial job (`chatRecoveryTaskRunOptions`: not
      // retained, keyed by its callback and incident) that ran its first
      // attempt into its `backoff` sleep: the run `waiting` on the sleep,
      // and the step journaled. It wakes a little after the upgrade's
      // start, so the held reply's silence is seen first.
      const runId = `chatrec_${crypto.randomUUID()}`;
      const wakeAt = now + 3_000;
      storage.sql.exec(
        `INSERT INTO cf_agents_task_runs
           (run_id, definition, input, state, metadata, idempotency_key,
            retain, attempt, generation, next_at, wait_reason, created_at,
            started_at, updated_at)
         VALUES (?, '__cf_internal_chat_recovery', ?, 'waiting', ?, ?, 0, 1,
                 NULL, ?, 'sleep', ?, ?, ?)`,
        runId,
        JSON.stringify({
          callback: "_chatRecoveryRetry",
          data: { incidentId },
          delaySeconds: 3
        }),
        JSON.stringify({ callback: "_chatRecoveryRetry", incidentId }),
        `chat-recovery:_chatRecoveryRetry:${incidentId}`,
        wakeAt,
        now - 1_000,
        now - 1_000,
        now - 1_000
      );
      storage.sql.exec(
        `INSERT INTO cf_agents_task_steps
           (run_id, step_name, kind, state, attempt, next_at, created_at,
            started_at, updated_at)
         VALUES (?, 'backoff', 'sleep', 'waiting', 0, ?, ?, ?, ?)`,
        runId,
        wakeAt,
        now - 1_000,
        now - 1_000,
        now - 1_000
      );
    });
    // Held while its job waits: nothing is posted at the upgrade's start.
    const agent = await getAgentByName(
      env.ThinkMessengerDeliveryTestAgent,
      name
    );
    expect(await agent.getAdapterCalls()).toEqual([]);
    expect(await postsAfterUpgrade(name, 1)).toEqual([
      INTERRUPTED_MESSENGER_RESPONSE
    ]);
  }, 30_000);
});
