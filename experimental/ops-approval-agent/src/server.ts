/**
 * Ops Approval Agent — a NON-CODING discovery prototype (qw-demo).
 *
 * Goal: build a realistic "reason over my business and take safe action" agent
 * on TODAY's Think APIs, and feel exactly where the Turns / Actions / Channels
 * RFCs would remove friction. Every hand-rolled workaround below is tagged with
 * a `GAP(...)` comment that maps to a finding in
 * `design/think-ops-demo-findings.md`.
 *
 * Domain: a refund/dispute operations agent. A human (or an upstream system)
 * asks it to process a refund. The agent looks up the order, then issues the
 * refund — a real, money-moving side effect that must be (a) permission-gated,
 * (b) human-approved, and (c) idempotent so a retry/redeploy never double-pays.
 *
 * Control surface (plain HTTP, routed to the agent stub — headless, no UI):
 *   POST /ops/grant?session=S           body: { scopes: string[] }
 *   POST /ops/request-refund?session=S  body: { orderId, amountCents, reason }
 *   POST /ops/inject-context?session=S  body: { note }
 *   GET  /ops/inspect?session=S&id=SUBMISSION_ID
 *   GET  /ops/debug?session=S
 */
import { getAgentByName, routeAgentRequest } from "agents";
import { Think } from "@cloudflare/think";
import { jsonSchema, tool, type ToolSet } from "ai";
import type { ThinkScheduledTasks } from "@cloudflare/think";

type OpsState = {
  /**
   * Permission scopes granted to this agent for now. Read at the top of every
   * side-effecting tool.
   *
   * GAP(actions): there is no first-class per-turn authorization. We persist an
   * ad-hoc scope set in agent state and re-check it by hand inside each
   * `execute`. The Actions RFC's `authorizeTurn()` + `action({ permissions })`
   * would make this declarative and enforced by the framework.
   */
  grantedScopes: string[];
};

type RefundLedgerRow = {
  idem_key: string;
  order_id: string;
  amount_cents: number;
  refund_id: string;
  at: number;
};

const MODEL_ID = "@cf/moonshotai/kimi-k2.7-code";

export class OpsApprovalAgent extends Think<Env, OpsState> {
  async onStart() {
    this._ensureLedger();
    if (!this.state) this.setState({ grantedScopes: [] });
  }

  getModel() {
    return MODEL_ID;
  }

  getSystemPrompt() {
    return [
      "You are an operations agent that processes customer refunds.",
      "When asked to refund an order: first call `lookup_order` to confirm it",
      "exists and is refundable, then call `issue_refund`. Never issue a refund",
      "larger than the order total. Summarize what you did in one sentence."
    ].join(" ");
  }

  getTools(): ToolSet {
    return {
      lookup_order: tool({
        description: "Look up an order's status and total before refunding.",
        inputSchema: jsonSchema<{ orderId: string }>({
          type: "object",
          properties: { orderId: { type: "string" } },
          required: ["orderId"]
        }),
        // Read-only: a "read" scope. Today the read/write distinction is just a
        // convention we enforce by hand; the model can't see it and the
        // framework doesn't know which tools mutate state.
        // GAP(actions): no declarative `permissions` / read-vs-write metadata.
        execute: async ({ orderId }) => {
          this._requireScope("orders:read");
          // Canned data — a real agent would call the commerce backend here.
          return {
            orderId,
            status: "paid",
            totalCents: 4200,
            currency: "USD",
            customer: "cust_demo"
          };
        }
      }),

      issue_refund: tool({
        description:
          "Issue a refund for an order. Requires human approval and is " +
          "idempotent per (order, amount).",
        inputSchema: jsonSchema<{
          orderId: string;
          amountCents: number;
          reason: string;
        }>({
          type: "object",
          properties: {
            orderId: { type: "string" },
            amountCents: { type: "number" },
            reason: { type: "string" }
          },
          required: ["orderId", "amountCents", "reason"]
        }),
        // GAP(actions): `needsApproval: true` parks the turn at
        // `approval-requested`, but there is no first-class SERVER-SIDE way to
        // resolve it. Approvals are resolved over the WebSocket chat protocol
        // (client sends the decision); the only programmatic approve/reject API
        // (`approveExecution`/`rejectExecution`) is specific to the codemode
        // execute tool, not generic `needsApproval` tools. The Actions RFC's
        // stable approval descriptor + a programmatic resolve path would close
        // this. For this prototype the turn parks here and stays parked.
        needsApproval: true,
        execute: async ({ orderId, amountCents, reason }) => {
          this._requireScope("refunds:write");

          // GAP(actions): hand-rolled idempotency ledger. The Actions RFC's
          // `cf_think_action_ledger` + `action({ idempotency })` would settle
          // this once, replay-safe across recovery/redeploys, without each
          // agent re-implementing the table, the key derivation, and the
          // "already issued" branch.
          const idemKey = `refund:${orderId}:${amountCents}`;
          const existing = this.sql<RefundLedgerRow>`
            SELECT * FROM cf_demo_refund_ledger WHERE idem_key = ${idemKey}
          `;
          if (existing.length > 0) {
            return {
              status: "already_issued",
              idempotent: true,
              refundId: existing[0].refund_id
            };
          }

          const refundId = `re_${crypto.randomUUID().slice(0, 8)}`;
          this.sql`
            INSERT INTO cf_demo_refund_ledger
              (idem_key, order_id, amount_cents, refund_id, at)
            VALUES (${idemKey}, ${orderId}, ${amountCents}, ${refundId}, ${Date.now()})
          `;
          return { status: "issued", refundId, amountCents, reason };
        }
      })
    };
  }

  getScheduledTasks(): ThinkScheduledTasks {
    // A proactive trigger: a daily digest turn the agent runs on its own.
    // GAP(turns): scheduled work is expressed as a natural-language `prompt`
    // string, a third turn-initiation shape distinct from `submitMessages`
    // (durable accept) and `saveMessages` (wait). The Turns RFC's `runTurn()`
    // would unify trigger + admission + body under one call.
    return {
      dailyRefundDigest: {
        schedule: "every 24 hours",
        prompt:
          "Summarize how many refunds were issued in the recent ledger and " +
          "flag any that look unusually large."
      }
    };
  }

  // ── Control methods (called from the Worker fetch via stub RPC) ──

  async grantScopes(scopes: string[]) {
    this.setState({ grantedScopes: scopes });
    return { grantedScopes: scopes };
  }

  /**
   * Durably accept a refund request and run it as a turn. The model will look
   * the order up and then call `issue_refund`, which parks at approval.
   *
   * GAP(turns): we reach for `submitMessages` here for durable acceptance +
   * later status, but a chat user would hit the WebSocket path and a "wait for
   * the answer" caller would use `saveMessages`. Three doors for "start a turn".
   */
  async requestRefund(input: {
    orderId: string;
    amountCents: number;
    reason: string;
  }) {
    const submissionId = crypto.randomUUID();
    const result = await this.submitMessages(
      [
        {
          id: crypto.randomUUID(),
          role: "user",
          parts: [
            {
              type: "text",
              text:
                `Please refund order ${input.orderId} for ` +
                `${input.amountCents} cents. Reason: ${input.reason}.`
            }
          ]
        }
      ],
      {
        submissionId,
        idempotencyKey: submissionId,
        metadata: { kind: "refund-request", ...input }
      }
    );
    return {
      submissionId: result.submissionId,
      accepted: result.accepted,
      status: result.status
    };
  }

  /**
   * Inject out-of-band context (e.g. an upstream "dispute escalated" webhook)
   * into the conversation WITHOUT starting a turn, so the next turn sees it.
   *
   * GAP(channels): `addMessages` makes the MODEL see the note, and a broadcast
   * makes connected WEB clients see it, but there is no single primitive to
   * "deliver a notice on a channel and optionally inform the model". The
   * Channels RFC's `deliverNotice({ informModel })` is exactly this shape — and
   * it would also let a non-web channel (voice, email, Slack) receive the
   * notice. Here we can only do the model-facing half.
   */
  async injectContext(note: string) {
    await this.addMessages([
      {
        id: crypto.randomUUID(),
        role: "user",
        parts: [{ type: "text", text: `[ops-context] ${note}` }]
      }
    ]);
    return { injected: true };
  }

  async debugState() {
    const ledger = this.sql<RefundLedgerRow>`
      SELECT * FROM cf_demo_refund_ledger ORDER BY at ASC
    `;
    const submissions = await this.listSubmissions({ limit: 25 });
    const transcript = this.messages.map((m) => ({
      role: m.role,
      parts: m.parts.map((p) => {
        const r = p as Record<string, unknown>;
        return { type: r.type, state: r.state };
      })
    }));
    return {
      grantedScopes: this.state?.grantedScopes ?? [],
      ledger,
      submissions,
      transcript
    };
  }

  // ── Internals ───────────────────────────────────────────────────

  private _ensureLedger() {
    this.sql`
      CREATE TABLE IF NOT EXISTS cf_demo_refund_ledger (
        idem_key TEXT PRIMARY KEY,
        order_id TEXT,
        amount_cents INTEGER,
        refund_id TEXT,
        at INTEGER
      )
    `;
  }

  /**
   * Hand-rolled authorization check. Throws (the error becomes the tool's
   * error result) when the scope was not granted.
   *
   * GAP(actions): every side-effecting tool repeats this. There is no
   * framework-level "this action needs scope X" declaration, no central
   * `authorizeTurn()`, and the denial isn't a structured, replayable outcome —
   * just a thrown string.
   */
  private _requireScope(scope: string) {
    const granted = this.state?.grantedScopes ?? [];
    if (!granted.includes(scope)) {
      throw new Error(
        `Permission denied: this agent has not been granted "${scope}". ` +
          `Grant it via POST /ops/grant before retrying.`
      );
    }
  }
}

// ── Worker: route control endpoints to the agent stub ─────────────

function json(data: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(data, null, 2), {
    ...init,
    headers: { "content-type": "application/json; charset=utf-8" }
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/ops/")) {
      const session = url.searchParams.get("session") ?? "default";
      const agent = await getAgentByName(env.OpsApprovalAgent, session);
      const action = url.pathname.slice("/ops/".length);

      try {
        switch (action) {
          case "grant": {
            const body = (await request.json().catch(() => ({}))) as {
              scopes?: string[];
            };
            return json(await agent.grantScopes(body.scopes ?? []));
          }
          case "request-refund": {
            const body = (await request.json().catch(() => ({}))) as Parameters<
              OpsApprovalAgent["requestRefund"]
            >[0];
            return json(await agent.requestRefund(body));
          }
          case "inject-context": {
            const body = (await request.json().catch(() => ({}))) as {
              note?: string;
            };
            return json(await agent.injectContext(body.note ?? ""));
          }
          case "inspect": {
            const id = url.searchParams.get("id");
            if (!id) return json({ error: "missing id" }, { status: 400 });
            return json(await agent.inspectSubmission(id));
          }
          case "debug":
            return json(await agent.debugState());
          default:
            return json({ error: `unknown action ${action}` }, { status: 404 });
        }
      } catch (error) {
        return json(
          { error: error instanceof Error ? error.message : String(error) },
          { status: 500 }
        );
      }
    }

    return (
      (await routeAgentRequest(request, env)) ||
      new Response("Not found", { status: 404 })
    );
  }
} satisfies ExportedHandler<Env>;
