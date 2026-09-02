import { getHostFunctionContext, run, RunError } from "@cloudflare/run";
import type { RunLimits, RunLog } from "@cloudflare/run";

/** Limit keys the API forwards to run() untouched — including invalid
 * values, so the escape room can demonstrate RUN_INVALID_INPUT. */
const FORWARDED_LIMIT_KEYS = [
  "timeoutMs",
  "cpuMs",
  "maxLogBytes",
  "maxSourceBytes",
  "maxHostFunctionCalls"
] as const;

/** JSON body accepted by POST /api/run. */
export interface RunRequestBody {
  source: string;
  limits?: Pick<RunLimits, (typeof FORWARDED_LIMIT_KEYS)[number]>;
  /**
   * Abort the run from the parent this many milliseconds in — the escape
   * room's RUN_ABORTED level. Bounded so a caller cannot park timers.
   */
  abortAfterMs?: number;
}

/** JSON response returned by POST /api/run. */
export interface RunApiResponse {
  ok: boolean;
  /** Formatted display string of the returned value (success only). */
  value?: string;
  /** Pretty-printed JSON of the full run result object (success only). */
  raw?: string;
  /** Stable RunError code (failure only). */
  code?: string;
  message?: string;
  /** Rewritten stack pointing at the submitted source lines, when available. */
  stack?: string;
  logs: RunLog[];
  /** Milliseconds spent inside run(), measured server-side. */
  durationMs: number;
}

/** Canned data behind the demo host functions. */
const CUSTOMERS = [
  { id: "cus_1", name: "Aria", plan: "pro", spend: 240 },
  { id: "cus_2", name: "Bram", plan: "free", spend: 0 },
  { id: "cus_3", name: "Cleo", plan: "enterprise", spend: 1900 },
  { id: "cus_4", name: "Dev", plan: "pro", spend: 480 },
  { id: "cus_5", name: "Elif", plan: "free", spend: 0 },
  { id: "cus_6", name: "Femi", plan: "pro", spend: 120 }
];

const DISPLAY_VALUE_MAX_CHARS = 16_384;

/**
 * The workerd bundled with wrangler/vite for local dev rejects child
 * compatibility dates newer than its own build, and @cloudflare/run pins a
 * recent date for its child Workers. Clamp the child to this example's own
 * `compatibility_date` during `vite dev` — any workerd that runs the example
 * supports it. Deployed Workers use the package's pinned date unchanged.
 */
function createLocalDevLoader(loader: WorkerLoader): WorkerLoader {
  const LOCAL_WORKERD_MAX_COMPATIBILITY_DATE = "2026-06-11";
  return {
    get(name, getCode) {
      return loader.get(name, async () => ({
        ...(await getCode()),
        compatibilityDate: LOCAL_WORKERD_MAX_COMPATIBILITY_DATE
      }));
    },
    load(code) {
      return loader.load({
        ...code,
        compatibilityDate: LOCAL_WORKERD_MAX_COMPATIBILITY_DATE
      });
    }
  };
}

const IS_LOCAL_DEV =
  (import.meta as { env?: { DEV?: boolean } }).env?.DEV === true;

/**
 * Pretty-print a run value for display, two-space indented. Workers RPC can
 * carry values JSON cannot (BigInt, Map, Set, Date, typed arrays, cycles),
 * so this walks the value itself instead of using JSON.stringify.
 */
function formatRunValue(
  value: unknown,
  seen = new Set<unknown>(),
  depth = 0
): string {
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "number":
      return Object.is(value, -0) ? "-0" : String(value);
    case "bigint":
      return `${value}n`;
    case "boolean":
      return String(value);
    default:
      break;
  }
  if (typeof value !== "object") return String(value);
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  const pad = "  ".repeat(depth + 1);
  const close = "  ".repeat(depth);
  const block = (open: string, entries: string[], shut: string): string =>
    entries.length === 0
      ? `${open}${shut}`
      : `${open}\n${pad}${entries.join(`,\n${pad}`)}\n${close}${shut}`;
  try {
    if (value instanceof Date) return `Date(${value.toISOString()})`;
    if (value instanceof RegExp) return String(value);
    if (value instanceof Map) {
      const entries = [...value.entries()].map(
        ([k, v]) =>
          `${formatRunValue(k, seen, depth + 1)} => ${formatRunValue(v, seen, depth + 1)}`
      );
      return block(`Map(${value.size}) {`, entries, "}");
    }
    if (value instanceof Set) {
      const entries = [...value.values()].map((v) =>
        formatRunValue(v, seen, depth + 1)
      );
      return block(`Set(${value.size}) {`, entries, "}");
    }
    if (value instanceof ArrayBuffer) {
      return `ArrayBuffer(${value.byteLength})`;
    }
    if (ArrayBuffer.isView(value)) {
      return `${value.constructor.name}(${value.byteLength} bytes)`;
    }
    if (Array.isArray(value)) {
      const entries = value.map((v) => formatRunValue(v, seen, depth + 1));
      return block("[", entries, "]");
    }
    const entries = Object.entries(value).map(
      ([k, v]) => `${k}: ${formatRunValue(v, seen, depth + 1)}`
    );
    return block("{", entries, "}");
  } finally {
    seen.delete(value);
  }
}

/** Parse and bound the request body; returns undefined when malformed. */
function parseRunRequestBody(value: unknown): RunRequestBody | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const source = Reflect.get(value, "source");
  if (typeof source !== "string") return undefined;
  const body: RunRequestBody = { source };
  const abortAfterMs = Reflect.get(value, "abortAfterMs");
  if (abortAfterMs !== undefined) {
    if (
      typeof abortAfterMs !== "number" ||
      abortAfterMs < 1 ||
      abortAfterMs > 30_000
    ) {
      return undefined;
    }
    body.abortAfterMs = abortAfterMs;
  }
  const rawLimits = Reflect.get(value, "limits");
  if (rawLimits === undefined) return body;
  if (typeof rawLimits !== "object" || rawLimits === null) return undefined;
  const limits: RunRequestBody["limits"] = {};
  for (const key of FORWARDED_LIMIT_KEYS) {
    const limit = Reflect.get(rawLimits, key);
    if (limit === undefined) continue;
    if (typeof limit !== "number") return undefined;
    limits[key] = limit;
  }
  body.limits = limits;
  return body;
}

async function handleRun(request: Request, env: Env): Promise<Response> {
  const body = parseRunRequestBody(await request.json().catch(() => null));
  if (body === undefined) {
    return Response.json(
      { error: "Expected { source: string, limits?: object }." },
      { status: 400 }
    );
  }

  // The escape room's RUN_ABORTED level: the parent pulls the plug mid-run.
  const abort =
    body.abortAfterMs === undefined ? undefined : new AbortController();
  const abortTimer =
    abort === undefined
      ? undefined
      : setTimeout(
          () => abort.abort(new Error("Unplugged by the parent Worker.")),
          body.abortAfterMs
        );

  const started = Date.now();
  try {
    const result = await run({
      loader: IS_LOCAL_DEV ? createLocalDevLoader(env.LOADER) : env.LOADER,
      source: body.source,
      ...(body.limits === undefined ? {} : { limits: body.limits }),
      ...(abort === undefined ? {} : { signal: abort.signal }),
      hostFunctions: {
        demo: {
          /** The only data authority the sandboxed code has. */
          async customers() {
            return CUSTOMERS;
          },
          /** Signal-aware sleep, so cancellation and timeouts reach it. */
          async wait(ms: number) {
            const { signal } = getHostFunctionContext();
            await new Promise<void>((resolve, reject) => {
              const timer = setTimeout(resolve, ms);
              signal.addEventListener(
                "abort",
                () => {
                  clearTimeout(timer);
                  reject(
                    signal.reason instanceof Error
                      ? signal.reason
                      : new Error("Host call aborted.")
                  );
                },
                { once: true }
              );
            });
            return ms;
          },
          /** Always throws — the escape room's RUN_HOST_FUNCTION_ERROR door. */
          async vault(): Promise<never> {
            throw new Error("The vault stays shut.");
          }
        }
      }
    });
    const response: RunApiResponse = {
      ok: true,
      value: formatRunValue(result.value).slice(0, DISPLAY_VALUE_MAX_CHARS),
      // Same walker as the value view — JSON.stringify would silently lose
      // what RPC preserved (-0 becomes 0, BigInt has no representation).
      raw: formatRunValue({
        status: result.status,
        value: result.value,
        logs: result.logs
      }).slice(0, 2 * DISPLAY_VALUE_MAX_CHARS),
      logs: result.logs,
      durationMs: Date.now() - started
    };
    return Response.json(response);
  } catch (error: unknown) {
    const durationMs = Date.now() - started;
    if (error instanceof RunError) {
      const response: RunApiResponse = {
        ok: false,
        code: error.code,
        message: error.message,
        ...(error.stack === undefined ? {} : { stack: error.stack }),
        logs: error.logs,
        durationMs
      };
      return Response.json(response);
    }
    const response: RunApiResponse = {
      ok: false,
      code: "UNEXPECTED",
      message: error instanceof Error ? error.message : String(error),
      logs: [],
      durationMs
    };
    return Response.json(response, { status: 500 });
  } finally {
    if (abortTimer !== undefined) clearTimeout(abortTimer);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/api/run" && request.method === "POST") {
      return handleRun(request, env);
    }
    return new Response("Not found", { status: 404 });
  }
} satisfies ExportedHandler<Env>;
