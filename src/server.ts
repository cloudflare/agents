import { routeAgentRequest } from "agents";
import { Think } from "@cloudflare/think";
import type { ThinkSubmissionInspection } from "@cloudflare/think";

const FIFTEEN_MINUTES_MS = 15 * 60 * 1000;
const SIXTEEN_MINUTES_MS = 16 * 60 * 1000;
const SIXTY_MINUTES_MS = 60 * 60 * 1000;

type Env = {
  RecoveryWindowAgent: DurableObjectNamespace<RecoveryWindowAgent>;
};

type CountRow = { count: number };

/**
 * Both interactive and long-running instances intentionally share this class.
 * The instance getter is the API shape requested in #2498. Version 0.20.0 never
 * reads it: recovery reads only this.constructor.submissionRecoveryStaleMs.
 */
export class RecoveryWindowAgent extends Think<Env> {
  protected static override submissionRecoveryStaleMs = FIFTEEN_MINUTES_MS;

  private instanceGetterReads = 0;
  private statusEvents: string[] = [];

  protected get submissionRecoveryStaleMs(): number | undefined {
    this.instanceGetterReads += 1;
    return this.desiredInstanceWindowMs();
  }

  override getModel() {
    // No inference is performed by this deterministic storage-level repro.
    return "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
  }

  override async onChatRecovery() {
    // Mirrors the affected application: the interrupted chat turn may continue
    // even though submission recovery has already emitted a terminal error.
    return { continue: true };
  }

  override async onSubmissionStatus(
    submission: ThinkSubmissionInspection
  ): Promise<void> {
    this.statusEvents.push(
      `${submission.submissionId}:${submission.status}:${submission.error ?? ""}`
    );
  }

  override async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    // agents 0.25.0 forwards the full routed URL; newer releases may forward
    // only the suffix. Accept either shape so the repro remains clickable.
    if (request.method !== "POST" || !url.pathname.endsWith("/run")) {
      return new Response("POST /run", { status: 404 });
    }

    try {
      return Response.json(await this.runRepro());
    } catch (error) {
      return Response.json(
        {
          error: error instanceof Error ? error.stack ?? error.message : String(error)
        },
        { status: 500 }
      );
    }
  }

  private desiredInstanceWindowMs(): number | undefined {
    return this.name === "long-running" ? SIXTY_MINUTES_MS : undefined;
  }

  private async runRepro() {
    const submissionId = "repro-2498-submission";
    const requestId = "repro-2498-request";
    const fiberId = "repro-2498-fiber";
    const fiberName = `${RecoveryWindowAgent.CHAT_FIBER_NAME}:${requestId}`;
    const now = Date.now();
    const evidenceCreatedAt = now - SIXTEEN_MINUTES_MS;
    const desiredInstanceWindowMs = this.desiredInstanceWindowMs();
    const effectiveExpectedWindowMs =
      desiredInstanceWindowMs ?? FIFTEEN_MINUTES_MS;

    // Force Think to create/migrate its submissions table, then make the demo
    // idempotent in case a prior click was interrupted.
    await this.inspectSubmission(submissionId);
    this.sql`DELETE FROM cf_think_submissions WHERE submission_id = ${submissionId}`;
    this.sql`DELETE FROM cf_agents_runs WHERE id = ${fiberId}`;

    const messagesJson = JSON.stringify([
      {
        id: "repro-2498-user-message",
        role: "user",
        parts: [{ type: "text", text: "continue the long-running turn" }]
      }
    ]);

    // Seed the exact state seen at startup after the alarm wall interrupts a
    // submission: messages were applied, status is still running, and a chat
    // fiber exists and is recoverable — but its evidence is 16 minutes old.
    this.sql`
      INSERT INTO cf_think_submissions (
        submission_id, idempotency_key, request_id, stream_id, status,
        messages_json, metadata_json, error_message, created_at,
        messages_applied_at, started_at, completed_at
      ) VALUES (
        ${submissionId}, NULL, ${requestId}, NULL, 'running',
        ${messagesJson}, NULL, NULL, ${evidenceCreatedAt},
        ${evidenceCreatedAt}, ${evidenceCreatedAt}, NULL
      )
    `;
    this.sql`
      INSERT INTO cf_agents_runs (id, name, snapshot, created_at)
      VALUES (${fiberId}, ${fiberName}, NULL, ${evidenceCreatedAt})
    `;

    const recoverableFiberBefore =
      (this.sql<CountRow>`
        SELECT COUNT(*) AS count FROM cf_agents_runs
        WHERE id = ${fiberId} AND completed_at IS NULL
      `[0]?.count ?? 0) === 1;

    this.instanceGetterReads = 0;
    this.statusEvents = [];
    await (
      this as unknown as {
        _recoverSubmissionsOnStart(): Promise<void>;
      }
    )._recoverSubmissionsOnStart();

    const actual = await this.inspectSubmission(submissionId);
    const recoverableFiberAfter =
      (this.sql<CountRow>`
        SELECT COUNT(*) AS count FROM cf_agents_runs
        WHERE id = ${fiberId} AND completed_at IS NULL
      `[0]?.count ?? 0) === 1;
    const statusEvents = [...this.statusEvents];
    const instanceGetterReadsDuringRecovery = this.instanceGetterReads;

    // Keep future cold starts deterministic; all evidence is returned below.
    this.sql`DELETE FROM cf_agents_runs WHERE id = ${fiberId}`;
    this.sql`DELETE FROM cf_think_submissions WHERE submission_id = ${submissionId}`;

    const expectedStatus =
      SIXTEEN_MINUTES_MS < effectiveExpectedWindowMs ? "running" : "error";
    const reproduced =
      this.name === "long-running" &&
      expectedStatus === "running" &&
      actual?.status === "error" &&
      instanceGetterReadsDuringRecovery === 0 &&
      recoverableFiberAfter;

    return {
      packageVersions: {
        "@cloudflare/think": "0.20.0",
        agents: "0.25.0"
      },
      instance: this.name,
      desiredInstanceWindowMs: desiredInstanceWindowMs ?? null,
      effectiveExpectedWindowMs,
      libraryStaticWindowMs: FIFTEEN_MINUTES_MS,
      evidenceAgeMs: SIXTEEN_MINUTES_MS,
      expectedStatus,
      actualStatus: actual?.status ?? null,
      actualError: actual?.error ?? null,
      instanceGetterReadsDuringRecovery,
      recoverableFiberBefore,
      recoverableFiberAfter,
      onChatRecoveryConfiguredToContinue: true,
      statusEvents,
      reproduced
    };
  }
}

export default {
  async fetch(request: Request, env: Env) {
    return (
      (await routeAgentRequest(request, env)) ||
      new Response("Not found", { status: 404 })
    );
  }
} satisfies ExportedHandler<Env>;
