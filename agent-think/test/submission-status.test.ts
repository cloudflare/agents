import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import type { ThinkSubmissionStatus } from "@cloudflare/think";
import { getAgentByName } from "agents";
import type { Inbox } from "agents/inbox";
import { describe, expect, it } from "vitest";
import { AgentThink, type ThinkAgent } from "../src/index";

async function createSubmission(
  agent: Awaited<ReturnType<typeof getAgentByName<Env, ThinkAgent>>>,
  input: {
    submissionId: string;
    status: ThinkSubmissionStatus;
    error?: string;
    createdAt: number;
    startedAt?: number;
    completedAt?: number;
  }
): Promise<void> {
  await runInDurableObject(agent, async (instance, state) => {
    // Seed the record the way the inbox stores it, without waking its lane,
    // so a pending or running seed stays as written.
    const { _submissions } = instance as unknown as { _submissions: Inbox };
    await _submissions.import({
      id: input.submissionId,
      kind: "submission",
      status: input.status,
      attempt: input.startedAt === undefined ? 0 : 1,
      idempotencyKey: `key-${input.submissionId}`,
      payload: { messages: [] },
      metadata: { instruction: "private workflow instruction" },
      progress: {
        requestId: `request-${input.submissionId}`,
        streamId: `stream-${input.submissionId}`
      },
      ...(input.error !== undefined && { error: input.error }),
      createdAt: input.createdAt,
      ...(input.startedAt !== undefined && { startedAt: input.startedAt }),
      ...(input.completedAt !== undefined && {
        settledAt: input.completedAt
      })
    });
    state.storage.sql.exec(
      "DELETE FROM cf_agents_jobs WHERE capability = 'inbox' AND fn = 'drain'"
    );
  });
}

describe("AgentThink submission status", () => {
  it("returns the durable submission status without its internal metadata", async () => {
    const agent = await getAgentByName<Env, ThinkAgent>(
      env.ThinkAgent,
      `run-status-${crypto.randomUUID()}`
    );
    const submissionId = crypto.randomUUID();

    await createSubmission(agent, {
      submissionId,
      status: "completed",
      createdAt: 100,
      startedAt: 200,
      completedAt: 300
    });

    await expect(
      agent.getSubmissionStatus(submissionId)
    ).resolves.toStrictEqual({
      status: "completed",
      createdAt: 100,
      startedAt: 200,
      completedAt: 300
    });
  });

  it("returns non-terminal state without terminal fields", async () => {
    const agent = await getAgentByName<Env, ThinkAgent>(
      env.ThinkAgent,
      `submission-pending-${crypto.randomUUID()}`
    );
    const submissionId = crypto.randomUUID();

    await createSubmission(agent, {
      submissionId,
      status: "pending",
      createdAt: 100
    });

    await expect(
      agent.getSubmissionStatus(submissionId)
    ).resolves.toStrictEqual({
      status: "pending",
      createdAt: 100
    });
  });

  it("returns the durable error details", async () => {
    const agent = await getAgentByName<Env, ThinkAgent>(
      env.ThinkAgent,
      `run-status-error-${crypto.randomUUID()}`
    );
    const submissionId = crypto.randomUUID();

    await createSubmission(agent, {
      submissionId,
      status: "error",
      error: "The model request failed.",
      createdAt: 100,
      startedAt: 200,
      completedAt: 300
    });

    await expect(
      agent.getSubmissionStatus(submissionId)
    ).resolves.toStrictEqual({
      status: "error",
      error: "The model request failed.",
      createdAt: 100,
      startedAt: 200,
      completedAt: 300
    });
  });

  it("resolves the session through the WorkerEntrypoint", async () => {
    const session = `submission-entrypoint-${crypto.randomUUID()}`;
    const agent = await getAgentByName<Env, ThinkAgent>(
      env.ThinkAgent,
      session
    );
    const submissionId = crypto.randomUUID();
    await createSubmission(agent, {
      submissionId,
      status: "running",
      createdAt: 100,
      startedAt: 200
    });
    const context = {
      passThroughOnException() {},
      waitUntil() {},
      props: {}
    } as unknown as ExecutionContext;
    const entrypoint = new AgentThink(context, env);

    await expect(
      entrypoint.getSubmissionStatus({ session, submissionId })
    ).resolves.toStrictEqual({
      status: "running",
      createdAt: 100,
      startedAt: 200
    });
  });

  it("returns null for an unknown submission", async () => {
    const agent = await getAgentByName<Env, ThinkAgent>(
      env.ThinkAgent,
      `submission-missing-${crypto.randomUUID()}`
    );

    await expect(
      agent.getSubmissionStatus(crypto.randomUUID())
    ).resolves.toBeNull();
  });
});
