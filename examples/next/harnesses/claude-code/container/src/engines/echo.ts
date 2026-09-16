/**
 * The echo engine: the container-side twin of the shared `EchoRuntime`
 * fixture. It needs no credentials and no model, which makes it two useful
 * things at once: the engine the daemon tests drive, and a keyless smoke
 * mode for a real deploy (`CF_HARNESS_ENGINE=echo`) that exercises the
 * whole path from the browser through the Durable Object to the container
 * and back without spending a token.
 *
 * Its behaviour matches the shared fixture on purpose, so the same
 * assertions hold whether the runtime is in the Durable Object or in a
 * container: `ask…` raises a permission request first, `slow…` waits until
 * it is interrupted, everything else echoes.
 */
import type {
  HarnessCapability,
  HarnessInput
} from "../../../../shared/src/types.ts";
import type { Engine, EngineContext } from "../engine.ts";
import { inputText } from "../engine.ts";

/** How long a `slow` prompt waits before giving up on being interrupted. */
const SLOW_MS = 5_000;

type Queued = {
  readonly operationId: string;
  readonly text: string;
  readonly delivery: "queue" | "steer";
};

export class EchoEngine implements Engine {
  readonly id = "echo";
  readonly version = "1";
  // No "steer": a steered prompt is queued here rather than folded into
  // the running turn, and advertising it would be a lie to the client.
  readonly capabilities: readonly HarnessCapability[] = ["requests"];
  readonly engineSession = null;

  #ctx: EngineContext | undefined;
  #queue: Queued[] = [];
  #active: string | null = null;
  #interrupted = new Set<string>();
  #draining: Promise<void> = Promise.resolve();

  get activeOperationId(): string | null {
    return this.#active;
  }

  async start(ctx: EngineContext): Promise<void> {
    this.#ctx = ctx;
  }

  async prompt(
    operationId: string,
    input: HarnessInput,
    delivery: "queue" | "steer"
  ): Promise<void> {
    this.#queue.push({ operationId, text: inputText(input), delivery });
    // Return as soon as the turn is admitted: `deliver()` must not wait for
    // the model, or an eviction mid-turn would look like a failed delivery.
    this.#pump();
  }

  async interrupt(operationId: string): Promise<void> {
    // An empty id means "whatever is running", which is what the base sends
    // when an interrupt arrives with no operation named.
    this.#interrupted.add(
      operationId === "" ? (this.#active ?? "") : operationId
    );
  }

  async shutdown(): Promise<void> {
    this.#queue = [];
  }

  /** Run queued turns one at a time, off the delivery path. */
  #pump(): void {
    this.#draining = this.#draining.then(async () => {
      for (;;) {
        const next = this.#queue.shift();
        if (next === undefined) return;
        try {
          await this.#run(next);
        } catch (error) {
          this.#ctx?.log("echo turn failed", error);
        }
      }
    });
  }

  async #run(turn: Queued): Promise<void> {
    const ctx = this.#ctx;
    if (ctx === undefined) return;
    const { operationId, text } = turn;
    this.#active = operationId;
    ctx.emit(operationId, {
      type: "begin",
      operationId,
      delivery: turn.delivery
    });
    const messageId = `assistant:${operationId}`;
    ctx.emit(operationId, {
      type: "message_start",
      messageId,
      role: "assistant"
    });

    if (text.startsWith("ask")) {
      const reply = await ctx.openRequest({
        requestId: `perm:${operationId}`,
        operationId,
        type: "permission",
        action: "Bash",
        resources: [text]
      });
      ctx.emit(operationId, {
        type: "extension",
        body: {
          type: "echo_permission",
          decision: reply.type === "permission" ? reply.decision : "n/a"
        }
      });
    }

    if (text.startsWith("slow")) await this.#waitForInterrupt(operationId);
    const interrupted = this.#interrupted.delete(operationId);

    ctx.preview(operationId, {
      type: "text_delta",
      messageId,
      delta: `echo: ${text}`
    });
    const echoed = interrupted ? "(interrupted)" : `echo: ${text}`;
    ctx.emit(operationId, {
      type: "message_end",
      messageId,
      role: "assistant",
      parts: [{ type: "text", text: echoed }]
    });
    ctx.emit(operationId, {
      type: "settle",
      operationId,
      settlement: {
        status: interrupted ? "aborted" : "completed",
        stopReason: { type: interrupted ? "interrupted" : "end_turn" },
        raw: { echoed }
      }
    });
    this.#active = null;
  }

  async #waitForInterrupt(operationId: string): Promise<void> {
    const deadline = Date.now() + SLOW_MS;
    while (Date.now() < deadline && !this.#interrupted.has(operationId)) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}
