import type { JsonValue } from "@earendil-works/chord";
import { Type } from "@earendil-works/pi-ai";
import type {
  ToolExecutionResult,
  ToolRegistration
} from "@earendil-works/pi-durable";

/** The Workers AI model the playground and the deployed e2e suite use. */
export const MODEL_ID = "@cf/moonshotai/kimi-k2.7-code";

/** Longest `sleep` the model may ask for. */
export const MAX_SLEEP_SECONDS = 3600;

/** A text tool result, with optional details for the UI. */
export function text(
  content: string,
  details?: JsonValue
): ToolExecutionResult {
  return {
    content: [{ type: "text", text: content }],
    ...(details === undefined ? {} : { details })
  };
}

/** pi validates arguments against `parameters` before `execute` runs. */
function argsOf<T>(args: JsonValue): T {
  return args as T;
}

function pause(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true }
    );
  });
}

/**
 * The playground's tools.
 *
 * `sleep` is the interesting one. It waits in memory with `setTimeout`, like
 * pi's own retry and poll sleeps, but memoizes its deadline in pi so it is
 * replay-safe: after an eviction pi reruns it and it only waits out what is
 * left. A timer does not keep the object alive by itself; the harness's wake
 * job does, through its alarm. See NOTES.md, "pi's timers are in
 * memory".
 */
export function createTools(): ToolRegistration[] {
  return [
    {
      name: "sleep",
      description: `Wait for a number of seconds (at most ${MAX_SLEEP_SECONDS}) before continuing.`,
      parameters: Type.Object({
        seconds: Type.Number({ minimum: 0, maximum: MAX_SLEEP_SECONDS })
      }),
      replay: "safe",
      async execute(args, api, context) {
        const { seconds } = argsOf<{ seconds: number }>(args);
        const startedAt = await api.memo("startedAt", Date.now(), context);
        const until = startedAt + seconds * 1000;
        api.output(`Sleeping until ${new Date(until).toISOString()}\n`);
        const remaining = until - Date.now();
        if (remaining > 0) await pause(remaining, context.abortSignal);
        const slept = (Date.now() - startedAt) / 1000;
        return text(`Slept ${slept.toFixed(1)}s.`, {
          seconds,
          startedAt: new Date(startedAt).toISOString(),
          endedAt: new Date().toISOString()
        });
      }
    },
    {
      name: "current_time",
      description: "Return the current UTC time.",
      parameters: Type.Object({}),
      replay: "safe",
      async execute() {
        const iso = new Date().toISOString();
        return text(iso, { iso });
      }
    }
  ];
}
