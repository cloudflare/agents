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
import {
  buildCaptureModel,
  buildReattachModel,
  parseReattachText
} from "./gateway-model";
import { planResume, type ResumeCheckpoint, type ResumePlan } from "./plan";

// `Env` is the global interface generated into env.d.ts by `wrangler types`.

type AgentState = {
  lastPlan?: ResumePlan | null;
  /** Event index we actually re-attached from (0 = full replay; see §recovery). */
  reattachFromEvent?: number;
};

/** Stash at most every Nth event so we don't hammer SQLite (RFC §9 throttle note). */
const STASH_EVERY = 8;

export class GatewayResumeAgent extends Think<Env, AgentState> {
  /** When set, the next getModel() returns a re-attach model and clears this. */
  private _pendingReattach: { runId: string; fromEvent: number } | null = null;
  /** Live mirror of what we've stashed for the in-flight turn (for /debug). */
  private _capture: ResumeCheckpoint | null = null;
  /** Last offset we stashed — drives the delta-based throttle (see onProgress). */
  private _lastStashedOffset = Number.NEGATIVE_INFINITY;
  /** Stash diagnostics (does the throttled onProgress stash actually persist?). */
  private _stashDiag = {
    attempts: 0,
    ok: 0,
    failed: 0,
    lastOk: null as number | null,
    lastError: null as string | null
  };

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
          this._lastStashedOffset = this._capture.eventOffset;
          this._safeStash(this._capture);
        },
        onProgress: (eventOffset) => {
          if (!this._capture) return;
          this._capture = { runId: this._capture.runId, eventOffset };
          // Delta-based throttle: SSE offsets JUMP (a single chunk can carry
          // several events), so a `% N` check often never lands on a boundary
          // and the offset would never get re-stashed. Stash once we've
          // advanced at least STASH_EVERY events since the last stash.
          if (eventOffset - this._lastStashedOffset >= STASH_EVERY) {
            this._lastStashedOffset = eventOffset;
            this._safeStash(this._capture);
          }
        }
      }
    });
  }

  protected override async onChatRecovery(
    ctx: ChatRecoveryContext
  ): Promise<ChatRecoveryOptions | void> {
    const plan = planResume(ctx.recoveryData, { createdAt: ctx.createdAt });

    if (plan.action === "reattach") {
      // Re-attach from event 0 (full replay), NOT the stashed tail offset.
      // The gateway run is DETACHED — it generates to completion after the
      // originating disconnect (proven in experimental/gateway-resume /detach),
      // so resume(from=0) replays the COMPLETE buffered run with zero
      // regenerated tokens and cleanly REPLACES the partial leaf (verified:
      // recovered === full run, byte-for-byte). A tail re-attach from the
      // stashed offset would save re-streaming the prefix, but under
      // continueLastTurn's replace semantics + the Layer-A↔SSE offset-space
      // mismatch (RFC §9.4) it can drop the prefix. from=0 is the robust,
      // proven zero-loss path. We still capture the offset (for observability).
      const fromEvent = 0;
      this.setState({
        ...(this.state ?? {}),
        lastPlan: plan,
        reattachFromEvent: fromEvent
      });
      this._pendingReattach = { runId: plan.runId, fromEvent };
      return { continue: true };
    }

    // No checkpoint / buffer likely expired — fall back to the default behavior.
    this.setState({ ...(this.state ?? {}), lastPlan: plan });
    return {};
  }

  private _safeStash(data: ResumeCheckpoint): void {
    this._stashDiag.attempts++;
    try {
      this.stash(data);
      this._stashDiag.ok++;
      this._stashDiag.lastOk = data.eventOffset;
    } catch (e) {
      // stash() throws outside a fiber; record it (capture is still mirrored).
      this._stashDiag.failed++;
      this._stashDiag.lastError = e instanceof Error ? e.message : String(e);
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
      stashDiag: this._stashDiag,
      transcript: this.messages.map((m: UIMessage) => ({
        role: m.role,
        text: this._messageText(m)
      }))
    };
  }

  /**
   * Prove **zero-loss reconstruction**: compare the recovered assistant message
   * (prefix that Layer A persisted before eviction + tail the re-attach appended
   * via `continueLastTurn`) against the ground-truth FULL run text parsed from
   * `resume?from=0`. A clean match means the DO-eviction recovery rebuilt the
   * whole answer with zero regenerated tokens, and the prefix/tail seam aligned.
   */
  async verify() {
    const plan = this.state?.lastPlan;
    const runId =
      plan && plan.action === "reattach" ? plan.runId : this._capture?.runId;
    if (!runId) return { error: "no runId to verify (recovery hasn't run?)" };

    const fullText = await parseReattachText({
      binding: this.env.AI,
      gateway: this.env.GATEWAY,
      slug: this.env.MODEL,
      runId,
      fromEvent: 0
    });

    const assistant = [...this.messages]
      .reverse()
      .find((m: UIMessage) => m.role === "assistant");
    const recovered = assistant ? this._messageText(assistant) : "";

    const match = recovered === fullText;
    let firstDivergence = -1;
    if (!match) {
      const n = Math.min(recovered.length, fullText.length);
      firstDivergence = n;
      for (let i = 0; i < n; i++) {
        if (recovered[i] !== fullText[i]) {
          firstDivergence = i;
          break;
        }
      }
    }

    return {
      runId,
      match,
      fullLen: fullText.length,
      recoveredLen: recovered.length,
      firstDivergence,
      reattachedFromEvent: this.state?.reattachFromEvent ?? null,
      stashedOffset: plan?.action === "reattach" ? plan.fromEvent : null,
      // small samples to eyeball the seam when a divergence is reported
      recoveredHead: recovered.slice(0, 64),
      fullHead: fullText.slice(0, 64),
      recoveredTail: recovered.slice(-64),
      fullTail: fullText.slice(-64)
    };
  }

  private _messageText(m: UIMessage): string {
    return m.parts
      .filter((p): p is { type: "text"; text: string } => p.type === "text")
      .map((p) => p.text)
      .join("");
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
          case "verify":
            return json(await agent.verify());
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
