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
 */
import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3StreamPart
} from "@ai-sdk/provider";

export type SyntheticMode = "progress" | "runaway" | "stuck";

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
