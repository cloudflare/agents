import { getAgentByName, routeAgentRequest } from "agents";
import { z } from "zod";
import { Think } from "@cloudflare/think";
import { ThinkWorkflow } from "@cloudflare/think/workflows";
import type { ThinkWorkflowStep } from "@cloudflare/think/workflows";
import type { AgentWorkflowEvent } from "agents/workflows";

type ReportParams = {
  reportId: string;
  topic: string;
};

type ReportRecord = {
  reportId: string;
  topic: string;
  status: "drafted" | "approved" | "rejected";
  draft?: z.infer<typeof reportDraftSchema>;
  approvalNotes?: string;
  updatedAt: string;
};

const reportDraftSchema = z.object({
  title: z.string(),
  summary: z.string(),
  recommendations: z.array(z.string()).min(1)
});

export class ReportAgent extends Think<Env> {
  getModel() {
    return "@cf/moonshotai/kimi-k2.7-code";
  }

  getSystemPrompt() {
    return [
      "You draft concise operational reports.",
      "Return practical recommendations that can be reviewed by a human."
    ].join("\n");
  }

  async startReport(
    topic: string
  ): Promise<{ reportId: string; workflowId: string }> {
    const reportId = crypto.randomUUID();
    const workflowId = await this.runWorkflow(
      "REPORT_WORKFLOW",
      { reportId, topic },
      { metadata: { reportId, topic } }
    );
    return { reportId, workflowId };
  }

  async approveReport(
    workflowId: string,
    approved: boolean,
    notes?: string
  ): Promise<void> {
    await this.sendWorkflowEvent("REPORT_WORKFLOW", workflowId, {
      type: "approval",
      payload: {
        approved,
        reason: approved ? undefined : notes,
        metadata: { notes }
      }
    });
  }

  async saveReport(record: ReportRecord): Promise<void> {
    this.sql`
      CREATE TABLE IF NOT EXISTS example_reports (
        report_id TEXT PRIMARY KEY,
        record_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `;
    this.sql`
      INSERT OR REPLACE INTO example_reports (report_id, record_json, updated_at)
      VALUES (${record.reportId}, ${JSON.stringify(record)}, ${record.updatedAt})
    `;
  }

  async getReport(reportId: string): Promise<ReportRecord | null> {
    const rows = this.sql<{ record_json: string }>`
      SELECT record_json
      FROM example_reports
      WHERE report_id = ${reportId}
      LIMIT 1
    `;
    return rows[0] ? (JSON.parse(rows[0].record_json) as ReportRecord) : null;
  }
}

export class ReportWorkflow extends ThinkWorkflow<ReportAgent, ReportParams> {
  async run(
    event: AgentWorkflowEvent<ReportParams>,
    step: ThinkWorkflowStep
  ): Promise<void> {
    const draft = await step.prompt("draft-report", {
      prompt: `Draft an operational report about: ${event.payload.topic}`,
      output: reportDraftSchema,
      timeout: "3 days"
    });

    await step.do("store-draft", async () => {
      await this.agent.saveReport({
        reportId: event.payload.reportId,
        topic: event.payload.topic,
        status: "drafted",
        draft,
        updatedAt: new Date().toISOString()
      });
    });

    const approvalEvent = await step.waitForEvent("wait-for-approval", {
      type: "approval",
      timeout: "7 days"
    });
    const approval = approvalEvent.payload as {
      approved: boolean;
      reason?: string;
      metadata?: { notes?: string };
    };

    if (!approval.approved) {
      await step.do("store-rejection", async () => {
        await this.agent.saveReport({
          reportId: event.payload.reportId,
          topic: event.payload.topic,
          status: "rejected",
          draft,
          approvalNotes: approval.reason ?? approval.metadata?.notes,
          updatedAt: new Date().toISOString()
        });
      });
      return;
    }

    await step.do("publish-or-reject", async () => {
      await this.agent.saveReport({
        reportId: event.payload.reportId,
        topic: event.payload.topic,
        status: "approved",
        draft,
        approvalNotes: approval.metadata?.notes,
        updatedAt: new Date().toISOString()
      });
    });
  }
}

async function getDefaultAgent(env: Env) {
  return getAgentByName(env.ReportAgent, "default");
}

export default {
  async fetch(request: Request, env: Env) {
    const agentResponse = await routeAgentRequest(request, env);
    if (agentResponse) return agentResponse;

    const url = new URL(request.url);
    const agent = await getDefaultAgent(env);

    if (request.method === "POST" && url.pathname === "/reports") {
      const body = (await request.json()) as { topic?: unknown };
      if (typeof body.topic !== "string" || body.topic.trim() === "") {
        return Response.json(
          { error: "Expected JSON body with topic" },
          {
            status: 400
          }
        );
      }
      return Response.json(await agent.startReport(body.topic));
    }

    const approvalMatch = url.pathname.match(/^\/reports\/([^/]+)\/approval$/);
    if (request.method === "POST" && approvalMatch) {
      const body = (await request.json()) as {
        approved?: unknown;
        notes?: unknown;
      };
      await agent.approveReport(
        approvalMatch[1],
        body.approved === true,
        typeof body.notes === "string" ? body.notes : undefined
      );
      return Response.json({ ok: true });
    }

    const reportMatch = url.pathname.match(/^\/reports\/([^/]+)$/);
    if (request.method === "GET" && reportMatch) {
      return Response.json(await agent.getReport(reportMatch[1]));
    }

    return Response.json(
      {
        routes: [
          "POST /reports { topic }",
          "POST /reports/:workflowId/approval { approved, notes }",
          "GET /reports/:reportId"
        ]
      },
      { status: 404 }
    );
  }
};
