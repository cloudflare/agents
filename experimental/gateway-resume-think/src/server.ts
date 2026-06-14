/**
 * Think Layer-B recipe — re-attach to an AI Gateway run on Durable Object
 * eviction instead of regenerating.
 *
 * The Agents SDK already buffers stream chunks for *client* reconnects (Layer A).
 * The gap this fills is **DO eviction mid-turn**: today `onChatRecovery` defaults
 * to `continueLastTurn()`, a fresh model call that re-spends tokens. Here we:
 *
 *   1. CAPTURE the run's `cf-aig-run-id` + live SSE event offset while streaming
 *      (the delegate's `onRunId` / `onProgress` hooks) and `stash()` them into the
 *      chat-recovery fiber so they survive eviction.
 *   2. On recovery, `planResume(ctx.recoveryData)` decides whether the gateway
 *      buffer is still live; if so we ARM a byte-exact re-attach.
 *   3. The scheduled continuation's `getModel()` returns a re-attach model that
 *      replays the exact tail from the stashed offset — zero new tokens.
 *
 * Eviction is simulated with `ctx.abort()` (see /interrupt), exactly like
 * `chat-recovery-probe`. The model is real (env.AI.run through a gateway), so a
 * full end-to-end run needs a deployed Worker + a unified-billing/BYOK gateway —
 * see scripts/driver.mjs and the README. The pure decision + re-attach glue is
 * unit-tested hermetically (src/*.test.ts).
 */
import { getAgentByName, routeAgentRequest } from "agents";
import { Think } from "@cloudflare/think";
import type {
  ChatRecoveryContext,
  ChatRecoveryOptions
} from "@cloudflare/think";
import type { UIMessage } from "ai";
import { buildCaptureModel, buildReattachModel } from "./gateway-model";
import { planResume, type ResumeCheckpoint, type ResumePlan } from "./plan";

// `Env` is the global interface generated into env.d.ts by `wrangler types`.

type AgentState = {
  lastPlan?: ResumePlan | null;
};

/** Stash only every Nth event so we don't hammer SQLite (RFC §9 throttle note). */
const STASH_EVERY = 8;

export class GatewayResumeAgent extends Think<Env, AgentState> {
  /** When set, the next getModel() returns a re-attach model and clears this. */
  private _pendingReattach: { runId: string; fromEvent: number } | null = null;
  /** Live mirror of what we've stashed for the in-flight turn (for /debug). */
  private _capture: ResumeCheckpoint | null = null;

  getModel() {
    if (this._pendingReattach) {
      const { runId, fromEvent } = this._pendingReattach;
      this._pendingReattach = null;
      return buildReattachModel({
        binding: this.env.AI,
        gateway: this.env.GATEWAY,
        slug: this.env.MODEL,
        runId,
        fromEvent
      });
    }

    return buildCaptureModel({
      binding: this.env.AI,
      gateway: this.env.GATEWAY,
      slug: this.env.MODEL,
      hooks: {
        onRunId: (runId) => {
          this._capture = {
            runId,
            eventOffset: this._capture?.eventOffset ?? 0
          };
          this._safeStash(this._capture);
        },
        onProgress: (eventOffset) => {
          if (!this._capture) return;
          this._capture = { runId: this._capture.runId, eventOffset };
          if (eventOffset % STASH_EVERY === 0) this._safeStash(this._capture);
        }
      }
    });
  }

  protected override async onChatRecovery(
    ctx: ChatRecoveryContext
  ): Promise<ChatRecoveryOptions | void> {
    const plan = planResume(ctx.recoveryData, { createdAt: ctx.createdAt });
    this.setState({ ...(this.state ?? {}), lastPlan: plan });

    if (plan.action === "reattach") {
      // Arm the next continuation to re-attach byte-exactly instead of
      // regenerating. The framework then schedules continueLastTurn(), whose
      // getModel() picks up the armed re-attach.
      this._pendingReattach = { runId: plan.runId, fromEvent: plan.fromEvent };
      return { continue: true };
    }

    // No checkpoint / buffer likely expired — fall back to the default behavior.
    return {};
  }

  private _safeStash(data: ResumeCheckpoint): void {
    try {
      this.stash(data);
    } catch {
      // stash() throws outside a fiber; ignore (capture is still mirrored for /debug)
    }
  }

  // ── demo control (called from the Worker fetch via stub RPC) ──

  async startChat(prompt: string) {
    const noop = {
      onStart: () => {},
      onEvent: () => {},
      onDone: () => {},
      onError: () => {}
    };
    // Fire-and-forget: the turn runs in the background, sustained across a
    // restart by the chat-recovery fiber.
    this.ctx.waitUntil(
      this.chat(prompt, noop).catch((e) =>
        console.error("[gw-resume] chat error", e)
      )
    );
    return { started: true, model: this.env.MODEL, gateway: this.env.GATEWAY };
  }

  async interrupt() {
    // ctx.abort() destroys this instance immediately (simulated eviction). The
    // in-flight fiber is interrupted; recovery fires on next access. The RPC
    // rejects by design.
    this.ctx.abort("gw-resume-interrupt");
    return { aborted: true };
  }

  async debug() {
    return {
      model: this.env.MODEL,
      gateway: this.env.GATEWAY,
      lastPlan: this.state?.lastPlan ?? null,
      capture: this._capture,
      transcript: this.messages.map((m: UIMessage) => ({
        role: m.role,
        text: m.parts
          .filter((p): p is { type: "text"; text: string } => p.type === "text")
          .map((p) => p.text)
          .join("")
      }))
    };
  }
}

function json(data: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(data, null, 2), {
    ...init,
    headers: { "content-type": "application/json; charset=utf-8" }
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/gw/")) {
      const session = url.searchParams.get("session") ?? "default";
      const agent = await getAgentByName(env.GatewayResumeAgent, session);
      const action = url.pathname.slice("/gw/".length);
      try {
        switch (action) {
          case "start": {
            const body = (await request.json().catch(() => ({}))) as {
              prompt?: string;
            };
            return json(
              await agent.startChat(
                body.prompt ?? "Write a few sentences about Cloudflare Workers."
              )
            );
          }
          case "interrupt": {
            await agent.interrupt().catch(() => {});
            return json({ aborted: true });
          }
          case "debug":
            return json(await agent.debug());
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
