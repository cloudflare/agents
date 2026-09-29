/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { ListTasksResponse, Role, Task, TaskState } from "@a2a-js/sdk";
import { A2A_ERROR_CODE } from "@a2a-js/sdk/errors";
import { env, runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { workflowInstanceId } from "../src/runtime/ids";
import { MAX_JSON_RPC_REQUEST_ID_BYTES } from "../src/runtime/json-validation";
import {
  DEFAULT_TERMINAL_TASK_RETENTION_MILLISECONDS,
  EVENT_RETENTION_MILLISECONDS
} from "../src/runtime/task-store";
import { contextShardIndex } from "../src/runtime/worker";

const token = "workerd-test-token";

describe("two-agent A2A Worker", () => {
  it("serves distinct Agent Cards and rejects unknown routes", async () => {
    const [coordinatorResponse, specialistResponse, missingResponse] =
      await Promise.all([
        SELF.fetch(
          "https://example.test/coordinator/.well-known/agent-card.json"
        ),
        SELF.fetch(
          "https://example.test/specialist/.well-known/agent-card.json"
        ),
        SELF.fetch("https://example.test/unknown")
      ]);

    expect(coordinatorResponse.status).toBe(200);
    expect(specialistResponse.status).toBe(200);
    expect(missingResponse.status).toBe(404);
    await expect(coordinatorResponse.json()).resolves.toMatchObject({
      name: "Coordinator Agent",
      supportedInterfaces: [{ url: "https://example.test/coordinator/a2a" }]
    });
    await expect(specialistResponse.json()).resolves.toMatchObject({
      name: "Specialist Agent",
      supportedInterfaces: [{ url: "https://example.test/specialist/a2a" }]
    });
  });

  it("uses one strict bearer-auth policy on both A2A endpoints", async () => {
    for (const route of ["coordinator", "specialist"]) {
      const response = await SELF.fetch(`https://example.test/${route}/a2a`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}"
      });
      expect(response.status).toBe(401);
      expect(response.headers.get("WWW-Authenticate")).toBe(
        'Bearer realm="a2a"'
      );
      await expect(response.json()).resolves.toEqual({
        error: "Unauthorized"
      });
    }
  });

  it("strips reserved lifecycle headers before Durable Object dispatch", async () => {
    const response = await SELF.fetch("https://example.test/specialist/a2a", {
      method: "POST",
      headers: {
        ...a2aHeaders(),
        "x-agents-lifecycle-props": "not-valid-base64!"
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "reserved-header",
        method: "ListTasks",
        params: { contextId: crypto.randomUUID() }
      })
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      id: "reserved-header",
      result: { tasks: [] }
    });
  });

  it.each([
    {
      name: "malformed JSON",
      body: '{"jsonrpc":',
      code: -32700,
      id: null
    },
    {
      name: "a valid JSON value without a JSON-RPC envelope",
      body: "[]",
      code: -32600,
      id: null
    },
    {
      name: "a request without an id",
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "GetExtendedAgentCard"
      }),
      code: -32600,
      id: null
    },
    {
      name: "a request with a null id",
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: null,
        method: "GetExtendedAgentCard"
      }),
      code: -32600,
      id: null
    },
    {
      name: "a request with an oversized id",
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "x".repeat(MAX_JSON_RPC_REQUEST_ID_BYTES + 1),
        method: "GetExtendedAgentCard"
      }),
      code: -32600,
      id: null
    },
    {
      name: "an unknown method without params",
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "unknown-method",
        method: "UnknownMethod"
      }),
      code: -32601,
      id: "unknown-method"
    },
    {
      name: "invalid known-method params",
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "invalid-params",
        method: "GetTask",
        params: {}
      }),
      code: -32602,
      id: "invalid-params"
    },
    {
      name: "a non-empty unsupported tenant",
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "unsupported-tenant",
        method: "ListTasks",
        params: { tenant: "another-owner" }
      }),
      code: -32602,
      id: "unsupported-tenant"
    }
  ])("maps $name to the correct JSON-RPC error", async ({ body, code, id }) => {
    const response = await SELF.fetch("https://example.test/specialist/a2a", {
      method: "POST",
      headers: a2aHeaders(),
      body
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      jsonrpc: "2.0",
      id,
      error: { code }
    });
  });

  it.each([
    ["missing", undefined],
    ["empty", ""]
  ])("treats a %s A2A version as legacy 0.3", async (_name, version) => {
    const headers = a2aHeaders();
    if (version === undefined) delete headers["A2A-Version"];
    else headers["A2A-Version"] = version;
    const response = await SELF.fetch("https://example.test/specialist/a2a", {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: crypto.randomUUID(),
        method: "ListTasks",
        params: { contextId: crypto.randomUUID() }
      })
    });

    await expect(response.json()).resolves.toMatchObject({
      error: { code: A2A_ERROR_CODE.VERSION_NOT_SUPPORTED }
    });
  });

  it("continues one Specialist task with a stable turn-derived Workflow ID", async () => {
    const contextId = crypto.randomUUID();
    const first = await sendMessage("specialist", {
      contextId,
      messageId: crypto.randomUUID(),
      text: "Challenge this draft.",
      returnImmediately: false
    });

    expect(first.status?.state).toBe(TaskState.TASK_STATE_INPUT_REQUIRED);
    expect(first.status?.message?.parts[0]?.content).toEqual({
      $case: "text",
      value: "Which constraint should the final answer prioritize?"
    });

    const completed = await sendMessage("specialist", {
      contextId,
      messageId: crypto.randomUUID(),
      taskId: first.id,
      text: "Prioritize correctness and verifiability.",
      returnImmediately: false
    });

    expect(completed.id).toBe(first.id);
    expect(completed.status?.state).toBe(TaskState.TASK_STATE_COMPLETED);
    expect(completed.metadata).toMatchObject({
      turn: 2,
      workflowInstanceId: workflowInstanceId(first.id, 2)
    });
    expect(
      completed.history.filter((message) => message.role === Role.ROLE_USER)
    ).toHaveLength(2);
    expect(completed.artifacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ artifactId: "joint-response" })
      ])
    );
  });

  it("derives a bounded Workflow ID when contextId is omitted", async () => {
    const task = await sendMessage("specialist", {
      messageId: crypto.randomUUID(),
      text: "Challenge this draft.",
      returnImmediately: false
    });

    expect(task.contextId).toBeTruthy();
    expect(task.metadata?.workflowInstanceId).toBe(
      workflowInstanceId(task.id, 1)
    );
    expect(String(task.metadata?.workflowInstanceId)).toHaveLength(43);
  });

  it("scopes message idempotency consistently to a context", async () => {
    const [firstContext, secondContext] = await contextsOnSameShard();
    const messageId = crypto.randomUUID();
    const [first, second] = await Promise.all([
      sendMessage("specialist", {
        contextId: firstContext,
        messageId,
        text: "Challenge the first draft.",
        returnImmediately: false
      }),
      sendMessage("specialist", {
        contextId: secondContext,
        messageId,
        text: "Challenge the second draft.",
        returnImmediately: false
      })
    ]);

    expect(first.id).not.toBe(second.id);
    expect(first.contextId).toBe(firstContext);
    expect(second.contextId).toBe(secondContext);
  });

  it("lists owner tasks without requiring a context filter", async () => {
    const task = await sendMessage("specialist", {
      contextId: crypto.randomUUID(),
      messageId: crypto.randomUUID(),
      text: "Include this task in the owner-wide listing.",
      returnImmediately: false
    });
    const response = await SELF.fetch("https://example.test/specialist/a2a", {
      method: "POST",
      headers: {
        "A2A-Version": "1.0",
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: crypto.randomUUID(),
        method: "ListTasks",
        params: {}
      })
    });
    const envelope = (await response.json()) as {
      error?: { message?: string };
      result?: { tasks?: Array<{ id?: string }> };
    };

    expect(response.status).toBe(200);
    expect(envelope.error).toBeUndefined();
    expect(envelope.result?.tasks).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: task.id })])
    );
  });

  it("merges status-ordered task pages across context shards", async () => {
    const [olderContext, newerContext] = await contextsOnDifferentShards();
    const statusBoundary = new Date().toISOString();
    await delay(5);
    const older = await sendMessage("specialist", {
      contextId: olderContext,
      messageId: crypto.randomUUID(),
      text: "Create the older task.",
      returnImmediately: false
    });
    await delay(5);
    const newer = await sendMessage("specialist", {
      contextId: newerContext,
      messageId: crypto.randomUUID(),
      text: "Create the newer task.",
      returnImmediately: false
    });
    await delay(5);
    const updatedOlder = await sendMessage("specialist", {
      contextId: olderContext,
      messageId: crypto.randomUUID(),
      taskId: older.id,
      text: "Prioritize correctness.",
      returnImmediately: false
    });

    expect(await contextShardIndex(olderContext)).not.toBe(
      await contextShardIndex(newerContext)
    );
    const updatedTimestamp = updatedOlder.status?.timestamp;
    const newerTimestamp = newer.status?.timestamp;
    if (!updatedTimestamp || !newerTimestamp) {
      throw new Error("Expected both tasks to have status timestamps.");
    }
    expect(updatedTimestamp > newerTimestamp).toBe(true);

    const firstPage = await listTasks("specialist", {
      pageSize: 1,
      statusTimestampAfter: statusBoundary
    });
    expect(firstPage.tasks.map((task) => task.id)).toEqual([older.id]);
    expect(firstPage.nextPageToken).not.toBe("");
    expect(firstPage.totalSize).toBe(2);

    const secondPage = await listTasks("specialist", {
      pageSize: 1,
      pageToken: firstPage.nextPageToken,
      statusTimestampAfter: statusBoundary
    });
    expect(secondPage.tasks.map((task) => task.id)).toEqual([newer.id]);
    expect(secondPage.nextPageToken).toBe("");

    const inclusive = await listTasks("specialist", {
      statusTimestampAfter: updatedTimestamp
    });
    expect(inclusive.tasks.map((task) => task.id)).toContain(older.id);
  });

  it("fails pending work when the alarm memory-limit breaker seals", async () => {
    const contextId = crypto.randomUUID();
    const task = await sendMessage("specialist", {
      contextId,
      messageId: crypto.randomUUID(),
      text: "Pause before memory-limit recovery testing.",
      returnImmediately: false
    });
    const workflowId = task.metadata?.workflowInstanceId;
    const turn = task.metadata?.turn;
    if (typeof workflowId !== "string" || typeof turn !== "number") {
      throw new Error("Expected persisted Workflow identity.");
    }

    const shard = await contextShardIndex(contextId);
    const stub = env.SPECIALIST.getByName(
      `specialist-client:a2a-shard:${shard}`
    );
    await runInDurableObject(stub, async (instance, state) => {
      const storedData = state.storage.sql
        .exec<{ data: string }>(
          "SELECT data FROM a2a_tasks WHERE id = ?",
          task.id
        )
        .one().data;
      const extraTaskIds = Array.from(
        { length: 9 },
        (_, index) => `${task.id}.memory-seal-${index}`
      );
      const terminalTaskId = `${task.id}.memory-seal-terminal`;
      for (const [index, taskId] of extraTaskIds.entries()) {
        const data = JSON.parse(storedData) as Record<string, unknown>;
        data.id = taskId;
        data.status = {
          state: "TASK_STATE_SUBMITTED",
          timestamp: new Date().toISOString()
        };
        const now = Date.now();
        state.storage.sql.exec(
          `INSERT INTO a2a_tasks (
             id, context_id, owner, workflow_instance_id, turn, state,
             status_timestamp, created_at, updated_at, data, normalized
           ) VALUES (?, ?, 'specialist-client', ?, 1, ?, ?, ?, ?, ?, 1)`,
          taskId,
          contextId,
          `${workflowId}.memory-seal-${index}`,
          TaskState.TASK_STATE_SUBMITTED,
          new Date(now).toISOString(),
          now,
          now,
          JSON.stringify(data)
        );
      }
      const terminalData = JSON.parse(storedData) as Record<string, unknown>;
      terminalData.id = terminalTaskId;
      terminalData.status = {
        state: "TASK_STATE_COMPLETED",
        timestamp: new Date().toISOString()
      };
      const terminalNow = Date.now();
      state.storage.sql.exec(
        `INSERT INTO a2a_tasks (
           id, context_id, owner, workflow_instance_id, turn, state,
           status_timestamp, created_at, updated_at, data, normalized
         ) VALUES (?, ?, 'specialist-client', ?, 1, ?, ?, ?, ?, ?, 1)`,
        terminalTaskId,
        contextId,
        `${workflowId}.memory-seal-terminal`,
        TaskState.TASK_STATE_COMPLETED,
        new Date(terminalNow).toISOString(),
        terminalNow,
        terminalNow,
        JSON.stringify(terminalData)
      );
      state.storage.sql.exec(
        `INSERT INTO a2a_cancellation_intents (
           task_id, workflow_instance_id, turn, params, requested_at
         ) VALUES (?, ?, ?, NULL, ?)`,
        task.id,
        workflowId,
        turn,
        Date.now()
      );
      state.storage.sql.exec(
        `INSERT INTO a2a_cancellation_intents (
           task_id, workflow_instance_id, turn, params, requested_at
         ) VALUES (?, ?, 1, NULL, ?)`,
        terminalTaskId,
        `${workflowId}.memory-seal-terminal`,
        Date.now()
      );
      state.storage.sql.exec(
        `INSERT INTO a2a_cancellation_hooks (task_id, data, created_at)
         VALUES (?, ?, ?)`,
        task.id,
        JSON.stringify(Task.toJSON(task)),
        Date.now()
      );

      await (
        instance as unknown as {
          onAlarmMemoryLimit(context: { sealed: boolean }): Promise<void>;
        }
      ).onAlarmMemoryLimit({ sealed: true });

      const row = state.storage.sql
        .exec<{ data: string; state: number }>(
          "SELECT data, state FROM a2a_tasks WHERE id = ?",
          task.id
        )
        .one();
      expect(row.state).toBe(TaskState.TASK_STATE_FAILED);
      expect(
        state.storage.sql
          .exec<{ count: number }>(
            `SELECT COUNT(*) AS count FROM a2a_tasks
             WHERE id IN (${[task.id, ...extraTaskIds].map(() => "?").join(", ")})
               AND state = ?`,
            task.id,
            ...extraTaskIds,
            TaskState.TASK_STATE_FAILED
          )
          .one().count
      ).toBe(10);
      expect(
        state.storage.sql
          .exec<{ state: number }>(
            "SELECT state FROM a2a_tasks WHERE id = ?",
            terminalTaskId
          )
          .one().state
      ).toBe(TaskState.TASK_STATE_COMPLETED);
      expect(JSON.parse(row.data)).toMatchObject({
        status: {
          state: "TASK_STATE_FAILED",
          message: {
            parts: [
              {
                text: expect.stringContaining("memory-limit retry budget")
              }
            ]
          }
        }
      });
      expect(
        state.storage.sql
          .exec<{ count: number }>(
            `SELECT COUNT(*) AS count FROM a2a_cancellation_intents
             WHERE task_id IN (?, ?)`,
            task.id,
            terminalTaskId
          )
          .one().count
      ).toBe(0);
      expect(
        JSON.parse(
          state.storage.sql
            .exec<{ data: string }>(
              `SELECT data FROM a2a_task_events WHERE task_id = ?
               ORDER BY sequence DESC LIMIT 1`,
              task.id
            )
            .one().data
        )
      ).toMatchObject({
        statusUpdate: {
          status: { state: "TASK_STATE_FAILED" }
        }
      });
      expect(
        state.storage.sql
          .exec<{ count: number }>(
            `SELECT COUNT(*) AS count
             FROM a2a_cancellation_hook_dead_letters
             WHERE task_id = ? AND reason LIKE '%memory-limit retry budget%'`,
            task.id
          )
          .one().count
      ).toBe(1);
    });
  });

  it("compacts aged interrupted events and terminal Workflow tracking", async () => {
    const contextId = crypto.randomUUID();
    const task = await sendMessage("specialist", {
      contextId,
      messageId: crypto.randomUUID(),
      text: "Pause this task for retention testing.",
      returnImmediately: false
    });
    expect(task.status?.state).toBe(TaskState.TASK_STATE_INPUT_REQUIRED);
    const workflowId = task.metadata?.workflowInstanceId;
    if (typeof workflowId !== "string") {
      throw new Error("Expected a tracked Workflow instance ID.");
    }

    const shard = await contextShardIndex(contextId);
    const stub = env.SPECIALIST.getByName(
      `specialist-client:a2a-shard:${shard}`
    );
    await runInDurableObject(stub, async (instance, state) => {
      const oldMilliseconds = Date.now() - EVENT_RETENTION_MILLISECONDS - 2_000;
      const oldSeconds = Math.floor(oldMilliseconds / 1_000);
      const eventCount = () =>
        state.storage.sql
          .exec<{ count: number }>(
            "SELECT COUNT(*) AS count FROM a2a_task_events WHERE task_id = ?",
            task.id
          )
          .one().count;
      const workflowCount = () =>
        state.storage.sql
          .exec<{ count: number }>(
            "SELECT COUNT(*) AS count FROM cf_agents_workflows WHERE workflow_id = ?",
            workflowId
          )
          .one().count;
      expect(eventCount()).toBeGreaterThan(0);
      expect(workflowCount()).toBe(1);

      state.storage.sql.exec(
        "UPDATE a2a_task_events SET created_at = ? WHERE task_id = ?",
        oldMilliseconds,
        task.id
      );
      state.storage.sql.exec(
        "UPDATE a2a_tasks SET updated_at = ? WHERE id = ?",
        oldMilliseconds,
        task.id
      );
      state.storage.sql.exec(
        `UPDATE cf_agents_workflows
         SET status = 'complete', completed_at = ?, updated_at = ?
         WHERE workflow_id = ?`,
        oldSeconds,
        oldSeconds,
        workflowId
      );

      await (
        instance as unknown as { runRecovery(): Promise<void> }
      ).runRecovery();

      expect(eventCount()).toBe(0);
      expect(workflowCount()).toBe(0);
    });
  });

  it("deletes aged terminal tasks and every task-owned row", async () => {
    const contextId = crypto.randomUUID();
    const first = await sendMessage("specialist", {
      contextId,
      messageId: crypto.randomUUID(),
      text: "Create a task for terminal retention testing.",
      returnImmediately: false
    });
    const completed = await sendMessage("specialist", {
      contextId,
      messageId: crypto.randomUUID(),
      taskId: first.id,
      text: "Prioritize correctness.",
      returnImmediately: false
    });
    expect(completed.status?.state).toBe(TaskState.TASK_STATE_COMPLETED);
    const workflowId = completed.metadata?.workflowInstanceId;
    const turn = completed.metadata?.turn;
    if (typeof workflowId !== "string" || typeof turn !== "number") {
      throw new Error("Expected persisted Workflow identity.");
    }

    const shard = await contextShardIndex(contextId);
    const stub = env.SPECIALIST.getByName(
      `specialist-client:a2a-shard:${shard}`
    );
    await runInDurableObject(stub, async (instance, state) => {
      const oldMilliseconds =
        Date.now() - DEFAULT_TERMINAL_TASK_RETENTION_MILLISECONDS - 2_000;
      const oldSeconds = Math.floor(oldMilliseconds / 1_000);
      state.storage.sql.exec(
        `INSERT INTO a2a_artifact_publications (
           publication_id, task_id, turn, fingerprint, published_at
         ) VALUES ('retention-publication', ?, ?, 'fingerprint', ?)`,
        completed.id,
        turn,
        oldMilliseconds
      );
      state.storage.sql.exec(
        `INSERT INTO a2a_cancellation_hook_dead_letters (
           task_id, data, failed_at, reason
         ) VALUES (?, ?, ?, 'retention test')`,
        completed.id,
        JSON.stringify(Task.toJSON(completed)),
        oldMilliseconds
      );
      state.storage.sql.exec(
        `INSERT INTO a2a_cancellation_intents (
           task_id, workflow_instance_id, turn, params, requested_at
         ) VALUES (?, ?, ?, NULL, ?)`,
        completed.id,
        workflowId,
        turn,
        oldMilliseconds
      );
      state.storage.sql.exec(
        `INSERT INTO a2a_cancellation_hooks (task_id, data, created_at)
         VALUES (?, ?, ?)`,
        completed.id,
        JSON.stringify(Task.toJSON(completed)),
        oldMilliseconds
      );
      state.storage.sql.exec(
        `INSERT INTO a2a_legacy_quarantine (task_id, error, quarantined_at)
         VALUES (?, 'retention test', ?)`,
        completed.id,
        oldMilliseconds
      );
      state.storage.sql.exec(
        `INSERT INTO a2a_quarantined_message_ids (
           context_id, message_id, task_id, fingerprint
         ) VALUES (?, 'retention-message', ?, 'fingerprint')`,
        contextId,
        completed.id
      );
      state.storage.sql.exec(
        "UPDATE a2a_task_events SET created_at = ? WHERE task_id = ?",
        oldMilliseconds,
        completed.id
      );
      state.storage.sql.exec(
        "UPDATE a2a_tasks SET updated_at = ? WHERE id = ?",
        oldMilliseconds,
        completed.id
      );
      state.storage.sql.exec(
        `UPDATE cf_agents_workflows
         SET status = 'complete', completed_at = ?, updated_at = ?
         WHERE workflow_id = ?`,
        oldSeconds,
        oldSeconds,
        workflowId
      );

      const ownedRowCount = () =>
        state.storage.sql
          .exec<{ count: number }>(
            `SELECT
               (SELECT COUNT(*) FROM a2a_tasks WHERE id = ?) +
               (SELECT COUNT(*) FROM a2a_task_history WHERE task_id = ?) +
               (SELECT COUNT(*) FROM a2a_task_artifacts WHERE task_id = ?) +
               (SELECT COUNT(*) FROM a2a_message_ids WHERE task_id = ?) +
               (SELECT COUNT(*) FROM a2a_task_events WHERE task_id = ?) +
               (SELECT COUNT(*) FROM a2a_artifact_publications WHERE task_id = ?) +
               (SELECT COUNT(*) FROM a2a_cancellation_intents WHERE task_id = ?) +
               (SELECT COUNT(*) FROM a2a_cancellation_hooks WHERE task_id = ?) +
               (SELECT COUNT(*) FROM a2a_cancellation_hook_dead_letters WHERE task_id = ?) +
               (SELECT COUNT(*) FROM a2a_legacy_quarantine WHERE task_id = ?) +
               (SELECT COUNT(*) FROM a2a_quarantined_message_ids WHERE task_id = ?)
               AS count`,
            ...Array.from({ length: 11 }, () => completed.id)
          )
          .one().count;
      const workflowCount = () =>
        state.storage.sql
          .exec<{ count: number }>(
            "SELECT COUNT(*) AS count FROM cf_agents_workflows WHERE workflow_id = ?",
            workflowId
          )
          .one().count;
      expect(ownedRowCount()).toBeGreaterThan(11);
      expect(workflowCount()).toBe(1);

      await (
        instance as unknown as { runRecovery(): Promise<void> }
      ).runRecovery();

      expect(ownedRowCount()).toBe(0);
      expect(workflowCount()).toBe(0);
    });
  });

  it("coordinates the largest supported Coordinator prompt", async () => {
    const completed = await sendMessage("coordinator", {
      contextId: crypto.randomUUID(),
      messageId: crypto.randomUUID(),
      text: "x".repeat(60 * 1024),
      returnImmediately: false
    });

    expect(completed.status?.state).toBe(TaskState.TASK_STATE_COMPLETED);
  });

  it("coordinates the full deterministic multi-agent conversation over A2A", async () => {
    const completed = await sendMessage("coordinator", {
      contextId: crypto.randomUUID(),
      messageId: crypto.randomUUID(),
      text: "How should we make a production migration safer?",
      returnImmediately: false
    });

    expect(completed.status?.state).toBe(TaskState.TASK_STATE_COMPLETED);
    expect(completed.metadata).toMatchObject({
      specialistContextId: expect.any(String),
      specialistContinuationResponse:
        "Prioritize correctness and verify the core assumption before optimizing.",
      specialistQuestion:
        "Which constraint should the final answer prioritize?",
      specialistTaskId: expect.any(String)
    });
    expect(completed.artifacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ artifactId: "coordinator-draft" }),
        expect.objectContaining({ artifactId: "specialist-progress" }),
        expect.objectContaining({ artifactId: "joint-response" })
      ])
    );
    expect(completed.status?.message?.parts[0]?.content).toMatchObject({
      $case: "text",
      value: expect.stringContaining("Coordinator and Specialist joint answer")
    });
  });
});

async function sendMessage(
  route: "coordinator" | "specialist",
  input: {
    contextId?: string;
    messageId: string;
    returnImmediately: boolean;
    taskId?: string;
    text: string;
  }
): Promise<Task> {
  const response = await SELF.fetch(`https://example.test/${route}/a2a`, {
    method: "POST",
    headers: {
      "A2A-Version": "1.0",
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: input.messageId,
      method: "SendMessage",
      params: {
        message: {
          messageId: input.messageId,
          contextId: input.contextId,
          taskId: input.taskId,
          role: "ROLE_USER",
          parts: [{ text: input.text }]
        },
        configuration: { returnImmediately: input.returnImmediately }
      }
    })
  });
  expect(response.status).toBe(200);
  const envelope = (await response.json()) as {
    error?: { message?: string };
    result?: unknown;
  };
  if (envelope.error) {
    throw new Error(envelope.error.message ?? "A2A request failed");
  }
  return Task.fromJSON(unwrapTask(envelope.result));
}

async function listTasks(
  route: "coordinator" | "specialist",
  params: Record<string, unknown>
): Promise<ListTasksResponse> {
  const response = await SELF.fetch(`https://example.test/${route}/a2a`, {
    method: "POST",
    headers: a2aHeaders(),
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: crypto.randomUUID(),
      method: "ListTasks",
      params
    })
  });
  expect(response.status).toBe(200);
  const envelope = (await response.json()) as {
    error?: { message?: string };
    result?: unknown;
  };
  if (envelope.error) {
    throw new Error(envelope.error.message ?? "ListTasks failed");
  }
  return ListTasksResponse.fromJSON(envelope.result);
}

async function contextsOnDifferentShards(): Promise<[string, string]> {
  const first = crypto.randomUUID();
  const firstShard = await contextShardIndex(first);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const candidate = crypto.randomUUID();
    if ((await contextShardIndex(candidate)) !== firstShard) {
      return [first, candidate];
    }
  }
  throw new Error("Could not generate contexts on different shards.");
}

async function contextsOnSameShard(): Promise<[string, string]> {
  const first = crypto.randomUUID();
  const firstShard = await contextShardIndex(first);
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const candidate = crypto.randomUUID();
    if ((await contextShardIndex(candidate)) === firstShard) {
      return [first, candidate];
    }
  }
  throw new Error("Could not generate contexts on the same shard.");
}

function a2aHeaders(): Record<string, string> {
  return {
    "A2A-Version": "1.0",
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json"
  };
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function unwrapTask(value: unknown): unknown {
  if (typeof value === "object" && value !== null && "task" in value) {
    return value.task;
  }
  return value;
}
