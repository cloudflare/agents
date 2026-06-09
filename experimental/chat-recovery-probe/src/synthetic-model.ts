/**
 * Synthetic slow "model" for the chat-recovery probe.
 *
 * It produces deterministic, monotonic content: one `tick N` line every
 * `intervalMs`, up to `targetSteps`. There is NO external LLM — the model runs
 * entirely inside the Durable Object, so the only thing that interrupts a turn
 * is a real isolate reset (a deploy) or an explicit `ctx.abort()`. That is
 * exactly the condition #1672 cares about: a turn making forward progress that
 * keeps getting interrupted.
 *
 * Modes:
 * - `progress` — emit ticks until `targetSteps`, then finish. A clean run takes
 *   `targetSteps * intervalMs`. On a continuation it RESUMES from the highest
 *   tick already present in the transcript, so progress is monotonic and the
 *   turn eventually converges no matter how many times it is interrupted.
 * - `runaway`  — never finishes (emits ticks forever). Used to exercise
 *   `maxRecoveryWork` / `shouldKeepRecovering`.
 * - `stuck`    — emits no content and parks until aborted, producing no forward
 *   progress. Used to exercise the no-progress timeout.
 * - `hitl`     — emits a CLIENT tool call (`ask_user`, no server `execute`) and
 *   finishes CLEANLY with `tool-calls`, so the turn PARKS at `input-available`
 *   awaiting the human (a `submitMessages` turn leaves its submission `running`,
 *   which the next isolate's boot-recovery sweep picks up). On the continuation
 *   that runs AFTER the client replays a `tool-result` (the prompt then carries
 *   a `role:"tool"` message) it emits a short final answer and finishes. Used to
 *   exercise the pending-client-interaction recovery exemption (the turn must
 *   NOT be sealed while parked, and must complete once the human replies).
 */
import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3StreamPart
} from "@ai-sdk/provider";

export type SyntheticMode =
  | "progress"
  | "runaway"
  | "stuck"
  | "hitl"
  | "server-orphan"
  | "approval";

/** The client tool the `hitl` mode calls. The driver must register a schema of
 *  this name in the request's `clientTools` so the framework treats the
 *  interrupted `input-available` part as CLIENT-resolvable (recovery-exempt),
 *  and replays its result under this `toolCallId`. */
export const HITL_TOOL_NAME = "ask_user";
export const HITL_TOOL_CALL_ID = "ask-user-call-1";

/** Tool-call emission for the "park on a tool" modes. The MODEL behavior is
 *  identical (emit one tool call, finish with `tool-calls`); the framework's
 *  reaction differs by tool kind, which is the whole point:
 *   - `hitl`          → `ask_user` is a CLIENT tool (registered via `clientTools`,
 *                       no `execute`): parks at `input-available`, recovery-exempt.
 *   - `server-orphan` → `slow_server` is a SERVER tool whose `execute` hangs;
 *                       evicted mid-execute it is a NON-client-resolvable orphan
 *                       (must recover via transcript repair, NOT park/seal).
 *   - `approval`      → `approve_action` has `needsApproval`: parks at
 *                       `approval-requested`, recovery-exempt regardless of
 *                       `clientTools`. */
const TOOL_PARK_MODES: Record<string, { name: string; callId: string }> = {
  hitl: { name: HITL_TOOL_NAME, callId: HITL_TOOL_CALL_ID },
  "server-orphan": { name: "slow_server", callId: "slow-server-call-1" },
  approval: { name: "approve_action", callId: "approve-action-call-1" }
};

export type SyntheticConfig = {
  mode: SyntheticMode;
  /** Total ticks for `progress` mode. Ignored for `runaway` / `stuck`. */
  targetSteps: number;
  /** Delay between ticks, ms. */
  intervalMs: number;
};

const EMPTY_USAGE = {
  inputTokens: {
    total: undefined,
    noCache: undefined,
    cacheRead: undefined,
    cacheWrite: undefined
  },
  outputTokens: {
    total: undefined,
    text: undefined,
    reasoning: undefined
  }
} as const;

const TICK_RE = /tick (\d+)/g;

/**
 * Highest tick number already present in the transcript's assistant messages.
 * Lets `progress` mode resume monotonically after an interruption.
 */
function highestTick(prompt: LanguageModelV3CallOptions["prompt"]): number {
  let max = 0;
  for (const message of prompt) {
    if (message.role !== "assistant") continue;
    for (const part of message.content) {
      if (part.type !== "text") continue;
      let m: RegExpExecArray | null;
      TICK_RE.lastIndex = 0;
      while ((m = TICK_RE.exec(part.text)) !== null) {
        const n = Number(m[1]);
        if (n > max) max = n;
      }
    }
  }
  return max;
}

/** Whether the prompt already carries a tool result — i.e. the client replayed
 *  `ask_user`'s answer, so the `hitl` continuation should finish the turn. */
function hasToolResult(prompt: LanguageModelV3CallOptions["prompt"]): boolean {
  return prompt.some((message) => message.role === "tool");
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        resolve();
      },
      { once: true }
    );
  });
}

function waitForAbort(signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (!signal || signal.aborted) return resolve();
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

export function createSyntheticModel(
  cfg: SyntheticConfig,
  /** Called once when the turn reaches `targetSteps` and finishes cleanly. */
  onComplete?: () => void
): LanguageModelV3 {
  return {
    specificationVersion: "v3",
    provider: "synthetic",
    modelId: `synthetic-${cfg.mode}`,
    supportedUrls: {},

    doGenerate: async () => {
      throw new Error("Synthetic probe model is stream-only");
    },

    doStream: async (options: LanguageModelV3CallOptions) => {
      const signal = options.abortSignal;
      const startTick = highestTick(options.prompt);
      const target =
        cfg.mode === "runaway"
          ? Number.POSITIVE_INFINITY
          : Math.max(cfg.targetSteps, startTick);

      const stream = new ReadableStream<LanguageModelV3StreamPart>({
        async start(controller) {
          const id = `txt-${crypto.randomUUID()}`;
          controller.enqueue({ type: "stream-start", warnings: [] });

          // Tool-park modes (hitl / server-orphan / approval): emit one tool
          // call and finish CLEANLY with `tool-calls`. The framework's reaction
          // depends on the tool kind (see `TOOL_PARK_MODES`). The continuation
          // that runs after the interaction settles (prompt then carries a
          // `role:"tool"` message) emits a short final answer and finishes.
          const park = TOOL_PARK_MODES[cfg.mode];
          if (park) {
            if (hasToolResult(options.prompt)) {
              controller.enqueue({ type: "text-start", id });
              controller.enqueue({
                type: "text-delta",
                id,
                delta: "Thanks — proceeding with your answer.\n"
              });
              controller.enqueue({ type: "text-end", id });
              controller.enqueue({
                type: "finish",
                finishReason: { unified: "stop", raw: undefined },
                usage: EMPTY_USAGE
              });
              onComplete?.();
              controller.close();
              return;
            }
            controller.enqueue({
              type: "tool-input-start",
              id: park.callId,
              toolName: park.name
            });
            controller.enqueue({
              type: "tool-input-delta",
              id: park.callId,
              delta: JSON.stringify({ question: "Proceed?" })
            });
            controller.enqueue({ type: "tool-input-end", id: park.callId });
            controller.enqueue({
              type: "tool-call",
              toolCallId: park.callId,
              toolName: park.name,
              input: JSON.stringify({ question: "Proceed?" })
            });
            // Finish CLEANLY with `tool-calls` so the framework settles the tool
            // call (parks a client/approval tool at `input-available` /
            // `approval-requested`, or executes a server tool) rather than
            // seeing a truncated stream.
            controller.enqueue({
              type: "finish",
              finishReason: { unified: "tool-calls", raw: undefined },
              usage: EMPTY_USAGE
            });
            controller.close();
            return;
          }

          controller.enqueue({ type: "text-start", id });

          // Stuck: produce nothing, park until aborted, end without finishing
          // so the turn is treated as interrupted (no forward progress).
          if (cfg.mode === "stuck") {
            await waitForAbort(signal);
            controller.close();
            return;
          }

          let n = startTick;
          while (n < target) {
            await sleep(cfg.intervalMs, signal);
            if (signal?.aborted) {
              // Interrupted: close without `finish` so the framework sees a
              // truncated turn and routes into recovery.
              controller.close();
              return;
            }
            n += 1;
            controller.enqueue({
              type: "text-delta",
              id,
              delta: `tick ${n}\n`
            });
          }

          controller.enqueue({ type: "text-end", id });
          controller.enqueue({
            type: "finish",
            finishReason: { unified: "stop", raw: undefined },
            usage: EMPTY_USAGE
          });
          // Durable, isolate-independent completion signal: this fires in
          // whatever isolate runs the continuation that reaches the target —
          // the only reliable "the turn finished" marker across deploy churn.
          if (cfg.mode === "progress") onComplete?.();
          controller.close();
        }
      });

      return { stream };
    }
  };
}
