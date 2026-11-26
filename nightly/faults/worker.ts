/**
 * The fault suite's Worker: an AIChatAgent and a Think agent on a scripted
 * fake model. The script streams text, calls tools (with text after the call
 * in the same step), stalls without closing, errors mid-stream, or answers
 * 429 (Retry-After / retry-after-ms) or 400 context_length_exceeded through
 * the real `@ai-sdk/openai` client, so the AI SDK builds and retries the
 * `APICallError` itself. Everything the agents do is recorded in the probe's
 * own tables and read back with `probeState`.
 *
 * `/ctl/<chat|think>/<room>/<method>` (POST, a JSON array of arguments) calls
 * the object.
 */
import { AIChatAgent, createToolsFromClientSchemas } from "@cloudflare/ai-chat";
import type { OnChatMessageOptions } from "@cloudflare/ai-chat";
import { Think, action } from "@cloudflare/think";
import type {
  ChatErrorClassification,
  ChatRecoveryConfig,
  ChatRecoveryContext,
  ChatRecoveryOptions,
  ChatResponseResult,
  MessageConcurrency,
  SaveMessagesOptions,
  SaveMessagesResult,
  Session,
  SessionMessage,
  StreamCallback,
  TurnConfig
} from "@cloudflare/think";
import { Agent, getAgentByName, routeAgentRequest } from "agents";
import { genericObservability } from "agents/observability";
import type { Observability, ObservabilityEvent } from "agents/observability";
import { createOpenAI } from "@ai-sdk/openai";
import { convertToModelMessages, isStepCount, streamText, tool } from "ai";
import type { LanguageModel, ToolSet, UIMessage } from "ai";
import { z } from "zod";

type Env = {
  /** Every request must carry it (`x-probe-key` or `?key=`): the suite sets it at deploy. */
  PROBE_KEY: string;
  /** What `/ready` names, so a suite can tell which deploy is serving. */
  BUILD: string;
  ProbeChat: DurableObjectNamespace<ProbeChat>;
  ProbeThink: DurableObjectNamespace<ProbeThink>;
  ProbeHub: DurableObjectNamespace<ProbeHub>;
};

// ── Script ────────────────────────────────────────────────────────────────

type Step =
  | {
      kind: "text";
      tokens?: number;
      delayMs?: number;
      /** Stop emitting after this many tokens and never close. */
      stallAfter?: number;
      /** Error the body after this many tokens. */
      errorAfter?: number;
    }
  | {
      kind: "tool";
      name: string;
      args?: Record<string, unknown>;
      textBefore?: number;
      textAfter?: number;
      delayMs?: number;
      /** Stall after the tool call (and textAfter) instead of finishing. */
      stallAfterTool?: boolean;
    }
  | {
      kind: "status";
      status: number;
      headers?: Record<string, string>;
      body?: string;
    }
  | { kind: "overflow" }
  | { kind: "auto" };

type ProbeConfig = {
  script?: Step[];
  /** Any request whose messages JSON is longer than this gets a 400 overflow. */
  overflowOverChars?: number;
  /** Delay inside the compaction function. */
  compactionDelayMs?: number;
  /** Compaction returns null (cannot shorten). */
  compactionNoOp?: boolean;
  recoveryContinue?: boolean;
  /** Think: classify these as rate_limit / transient. */
  classify?: "rate_limit" | "transient" | "none";
  /** Think TurnConfig.maxRetries (AI SDK retries). */
  maxRetries?: number;
  /** AIChatAgent: streamText maxRetries. */
  stallMs?: number;
  maxAttempts?: number;
  stableTimeoutMs?: number;
  /** Throw from continueLastTurn while a recovery attempt runs it. */
  throwInRecoveryContinue?: boolean;
  /** AIChatAgent: call abortAllRequests() inside onChatMessage after this delay. */
  abortAllInOnChatMessageMs?: number;
  /** AIChatAgent: pass the abort signal to streamText. */
  passSignal?: boolean;
  /** Think: enable reactive overflow recovery. */
  overflow?: boolean;
  serverToolDelayMs?: number;
  concurrency?: unknown;
  /** Throw a platform transient ("Network connection lost.") once from continueLastTurn in an attempt. */
  transientInRecoveryOnce?: boolean;
  /** onChatRecovery declines from its Nth call on (1-based). */
  declineFromCall?: number;
  /** Throw a platform transient once from waitUntilStable (the attempt's stable wait). */
  transientInStableWaitOnce?: boolean;
  /** onChatRecovery stops the request it is asked about (a stop inside the stall route). */
  stopInOnChatRecovery?: boolean;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function tables(sql: SqlFn) {
  sql`CREATE TABLE IF NOT EXISTS probe_cfg (k TEXT PRIMARY KEY, v TEXT)`;
  sql`CREATE TABLE IF NOT EXISTS probe_events (seq INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER, type TEXT, json TEXT)`;
  sql`CREATE TABLE IF NOT EXISTS probe_responses (seq INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER, json TEXT)`;
  sql`CREATE TABLE IF NOT EXISTS probe_calls (seq INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER, json TEXT)`;
  sql`CREATE TABLE IF NOT EXISTS probe_notes (seq INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER, json TEXT)`;
}

type SqlFn = (
  strings: TemplateStringsArray,
  ...values: (string | number | boolean | null)[]
) => Record<string, unknown>[];

function readConfig(sql: SqlFn): ProbeConfig {
  tables(sql);
  const rows = sql`SELECT v FROM probe_cfg WHERE k = 'cfg'` as { v: string }[];
  return rows[0] ? (JSON.parse(rows[0].v) as ProbeConfig) : {};
}
function writeConfig(sql: SqlFn, cfg: ProbeConfig) {
  tables(sql);
  sql`INSERT OR REPLACE INTO probe_cfg (k, v) VALUES ('cfg', ${JSON.stringify(cfg)})`;
  sql`INSERT OR REPLACE INTO probe_cfg (k, v) VALUES ('scriptIdx', '0')`;
}
function nextScriptIndex(sql: SqlFn): number {
  const rows = sql`SELECT v FROM probe_cfg WHERE k = 'scriptIdx'` as {
    v: string;
  }[];
  const i = rows[0] ? Number(rows[0].v) : 0;
  sql`INSERT OR REPLACE INTO probe_cfg (k, v) VALUES ('scriptIdx', ${String(i + 1)})`;
  return i;
}
function note(sql: SqlFn, value: unknown) {
  try {
    tables(sql);
    sql`INSERT INTO probe_notes (at, json) VALUES (${Date.now()}, ${JSON.stringify(value)})`;
  } catch {
    // storage may be gone
  }
}

function eventSummary(event: ObservabilityEvent): Record<string, unknown> {
  const payload =
    (event as { payload?: Record<string, unknown> }).payload ?? {};
  const keep: Record<string, unknown> = {};
  for (const key of [
    "incidentId",
    "status",
    "reason",
    "outcome",
    "kind",
    "trigger",
    "continuation",
    "requestId",
    "shortened",
    "attempt",
    "error"
  ]) {
    if (key in payload)
      keep[key] =
        typeof payload[key] === "string"
          ? String(payload[key]).slice(0, 120)
          : payload[key];
  }
  return keep;
}

function recordingObservability(sql: SqlFn): Observability {
  return {
    emit(event) {
      try {
        tables(sql);
        sql`INSERT INTO probe_events (at, type, json) VALUES (${Date.now()}, ${event.type}, ${JSON.stringify(eventSummary(event))})`;
      } catch {
        // storage may be gone during a reset
      }
      genericObservability.emit(event);
    }
  };
}

// ── Fake provider ─────────────────────────────────────────────────────────

type OAIMessage = {
  role: string;
  content?: unknown;
  tool_calls?: unknown[];
};

function lastUserText(messages: OAIMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "user") continue;
    if (typeof m.content === "string") return m.content;
    if (Array.isArray(m.content)) {
      return m.content.map((c) => (c as { text?: string }).text ?? "").join("");
    }
  }
  return "";
}

function autoStep(messages: OAIMessage[]): Step {
  const last = messages.at(-1);
  const text = lastUserText(messages);
  if (last?.role === "tool") {
    if (text.includes("[cstall]"))
      return { kind: "text", tokens: 20, delayMs: 20, stallAfter: 2 };
    return { kind: "text", tokens: 6, delayMs: 15 };
  }
  if (text.includes("[cstall]"))
    return { kind: "tool", name: "getUserLocation", textBefore: 1 };
  if (text.includes("[429]"))
    return { kind: "status", status: 429, headers: { "retry-after": "2" } };
  if (text.includes("[overflow]")) return { kind: "overflow" };
  if (text.includes("[client]"))
    return { kind: "tool", name: "getUserLocation", textBefore: 2 };
  if (text.includes("[server]"))
    return { kind: "tool", name: "getWeather", args: { city: "Paris" } };
  if (text.includes("[approve]"))
    return { kind: "tool", name: "deleteFile", args: { path: "/tmp/x" } };
  if (text.includes("[midtool]"))
    return {
      kind: "tool",
      name: "getUserLocation",
      textBefore: 2,
      textAfter: 30,
      delayMs: 60
    };
  if (text.includes("[slow]")) return { kind: "text", tokens: 40, delayMs: 50 };
  if (text.includes("[stall]"))
    return { kind: "text", tokens: 20, delayMs: 20, stallAfter: 3 };
  if (text.includes("[error]"))
    return { kind: "text", tokens: 20, delayMs: 20, errorAfter: 3 };
  return { kind: "text", tokens: 8, delayMs: 20 };
}

/** The provider-level model the fake stands in for, and its stream parts. */
type ProviderModel = ReturnType<ReturnType<typeof createOpenAI>["chat"]>;
type CallOptions = Parameters<ProviderModel["doStream"]>[0];
type Part =
  Awaited<
    ReturnType<ProviderModel["doStream"]>
  >["stream"] extends ReadableStream<infer P>
    ? P
    : never;

function partsStream(
  step: Step,
  signal: AbortSignal | undefined,
  onEnd: (how: string) => void,
  tag?: string
): ReadableStream<Part> {
  let closed = false;
  const usage = {
    inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 10, text: 10, reasoning: 0 }
  };
  const waitAbort = () =>
    new Promise<void>((resolve) => {
      if (signal?.aborted) return resolve();
      signal?.addEventListener("abort", () => resolve(), { once: true });
    });
  return new ReadableStream<Part>({
    async start(controller) {
      const wait = async (ms: number) => {
        if (ms) await sleep(ms);
        if (signal?.aborted) throw new Error("aborted");
      };
      const stall = async () => {
        onEnd("stall");
        await waitAbort();
        closed = true;
        try {
          controller.error(new Error("aborted after stall"));
        } catch {
          // ignore
        }
      };
      try {
        controller.enqueue({ type: "stream-start", warnings: [] });
        if (step.kind === "text") {
          const n = step.tokens ?? 8;
          if (step.stallAfter === 0) return await stall();
          controller.enqueue({ type: "text-start", id: "t0" });
          for (let i = 1; i <= n; i++) {
            if (step.stallAfter !== undefined && i > step.stallAfter)
              return await stall();
            if (step.errorAfter !== undefined && i > step.errorAfter) {
              closed = true;
              onEnd("error");
              controller.error(new Error("fake: injected provider failure"));
              return;
            }
            await wait(step.delayMs ?? 0);
            controller.enqueue({
              type: "text-delta",
              id: "t0",
              delta: `${i === 1 && tag ? `[re:${tag}] ` : ""}w${i} `
            });
          }
          controller.enqueue({ type: "text-end", id: "t0" });
          controller.enqueue({
            type: "finish",
            finishReason: { unified: "stop", raw: "stop" },
            usage
          });
          closed = true;
          onEnd("done");
          controller.close();
          return;
        }
        if (step.kind === "tool") {
          if (step.textBefore) {
            controller.enqueue({ type: "text-start", id: "tb" });
            for (let i = 1; i <= step.textBefore; i++) {
              await wait(step.delayMs ?? 0);
              controller.enqueue({
                type: "text-delta",
                id: "tb",
                delta: `${i === 1 && tag ? `[re:${tag}] ` : ""}b${i} `
              });
            }
            controller.enqueue({ type: "text-end", id: "tb" });
          }
          await wait(step.delayMs ?? 0);
          const id = `call_${crypto.randomUUID().slice(0, 8)}`;
          const input = JSON.stringify(step.args ?? {});
          controller.enqueue({
            type: "tool-input-start",
            id,
            toolName: step.name
          });
          controller.enqueue({ type: "tool-input-delta", id, delta: input });
          controller.enqueue({ type: "tool-input-end", id });
          controller.enqueue({
            type: "tool-call",
            toolCallId: id,
            toolName: step.name,
            input
          });
          if (step.textAfter) {
            controller.enqueue({ type: "text-start", id: "ta" });
            for (let i = 1; i <= step.textAfter; i++) {
              await wait(step.delayMs ?? 0);
              controller.enqueue({
                type: "text-delta",
                id: "ta",
                delta: `a${i} `
              });
            }
            controller.enqueue({ type: "text-end", id: "ta" });
          }
          if (step.stallAfterTool) return await stall();
          controller.enqueue({
            type: "finish",
            finishReason: { unified: "tool-calls", raw: "tool_calls" },
            usage
          });
          closed = true;
          onEnd("done");
          controller.close();
        }
      } catch (e) {
        if (!closed) {
          closed = true;
          onEnd("aborted");
          try {
            controller.error(e);
          } catch {
            // ignore
          }
        }
      }
    },
    cancel() {
      if (!closed) {
        closed = true;
        onEnd("cancelled");
      }
    }
  });
}

function fakeModel(sql: SqlFn): LanguageModel {
  // Status and overflow steps go through a real provider client and a fake
  // HTTP endpoint, so the AI SDK builds and retries the APICallError itself.
  let forced: Step | null = null;
  const fetchImpl = async (): Promise<Response> => {
    const step = forced;
    forced = null;
    if (!step || step.kind === "overflow") return overflowResponse();
    if (step.kind === "status") {
      return new Response(
        step.body ??
          JSON.stringify({
            error: {
              message: `fake status ${step.status}`,
              type: "rate_limit_error",
              code: "rate_limited"
            }
          }),
        {
          status: step.status,
          headers: {
            "content-type": "application/json",
            ...(step.headers ?? {})
          }
        }
      );
    }
    return overflowResponse();
  };
  const http = createOpenAI({
    apiKey: "fake",
    baseURL: "https://fake-provider.invalid/v1",
    fetch: fetchImpl as unknown as typeof fetch
  }).chat("fake-model");
  const model: ProviderModel = {
    specificationVersion: "v4",
    provider: "fake",
    modelId: "fake-model",
    supportedUrls: {},
    async doGenerate() {
      throw new Error("fake: doGenerate not supported");
    },
    async doStream(options: CallOptions) {
      const cfg = readConfig(sql);
      const messages = (options.prompt ?? []) as OAIMessage[];
      const chars = JSON.stringify(messages).length;
      const at = Date.now();
      const log = (step: string, extra: Record<string, unknown> = {}) => {
        try {
          tables(sql);
          sql`INSERT INTO probe_calls (at, json) VALUES (${at}, ${JSON.stringify(
            {
              step,
              last: messages.at(-1)?.role,
              n: messages.length,
              chars,
              user: lastUserText(messages).slice(0, 40),
              ...extra
            }
          )})`;
        } catch {
          // ignore
        }
      };
      if (
        cfg.overflowOverChars !== undefined &&
        chars > cfg.overflowOverChars
      ) {
        log("overflow-size");
        forced = { kind: "overflow" };
        return http.doStream(options);
      }
      const idx = nextScriptIndex(sql);
      let step: Step = cfg.script?.[idx] ?? { kind: "auto" };
      if (step.kind === "auto") step = autoStep(messages);
      if (step.kind === "overflow" || step.kind === "status") {
        log(step.kind === "status" ? `status-${step.status}` : "overflow", {
          idx
        });
        forced = step;
        return http.doStream(options);
      }
      log(step.kind === "tool" ? `tool-${step.name}` : "text", { idx });
      const tagMatch = lastUserText(messages).match(/msg (\d+)/g);
      const tag = tagMatch ? tagMatch[tagMatch.length - 1].slice(4) : undefined;
      const stream = partsStream(
        step,
        options.abortSignal,
        (how) => {
          try {
            sql`INSERT INTO probe_calls (at, json) VALUES (${Date.now()}, ${JSON.stringify({ end: how, idx })})`;
          } catch {
            // ignore
          }
        },
        tag
      );
      return { stream };
    }
  };
  return model as LanguageModel;
}

function overflowResponse() {
  return new Response(
    JSON.stringify({
      error: {
        message:
          "This model's maximum context length is 100 tokens. However, your messages resulted in 900 tokens. (context_length_exceeded)",
        type: "invalid_request_error",
        code: "context_length_exceeded"
      }
    }),
    { status: 400, headers: { "content-type": "application/json" } }
  );
}

function serverTools(cfg: ProbeConfig): ToolSet {
  return {
    getWeather: tool({
      description: "Get the current weather for a city.",
      inputSchema: z.object({ city: z.string() }),
      execute: async ({ city }) => {
        if (cfg.serverToolDelayMs) await sleep(cfg.serverToolDelayMs);
        return { city, condition: "sunny", temperatureC: 21 };
      }
    }),
    deleteFile: tool({
      description: "Delete a file by path. Requires the user's approval.",
      inputSchema: z.object({ path: z.string() }),
      needsApproval: true,
      execute: async ({ path }) => ({ deleted: path })
    })
  };
}

function readLog(sql: SqlFn) {
  tables(sql);
  const events = (
    sql`SELECT at, type, json FROM probe_events ORDER BY seq` as {
      at: number;
      type: string;
      json: string;
    }[]
  ).map((r) => ({ at: r.at, type: r.type, ...JSON.parse(r.json) }));
  const responses = (
    sql`SELECT at, json FROM probe_responses ORDER BY seq` as {
      at: number;
      json: string;
    }[]
  ).map((r) => ({
    at: r.at,
    ...JSON.parse(r.json)
  }));
  const calls = (
    sql`SELECT at, json FROM probe_calls ORDER BY seq` as {
      at: number;
      json: string;
    }[]
  ).map((r) => ({
    at: r.at,
    ...JSON.parse(r.json)
  }));
  const notes = (
    sql`SELECT at, json FROM probe_notes ORDER BY seq` as {
      at: number;
      json: string;
    }[]
  ).map((r) => ({
    at: r.at,
    ...JSON.parse(r.json)
  }));
  return { events, responses, calls, notes };
}

function flagOnce(sql: SqlFn, key: string): boolean {
  tables(sql);
  const rows = sql`SELECT v FROM probe_cfg WHERE k = ${key}` as { v: string }[];
  if (rows[0]) return false;
  sql`INSERT OR REPLACE INTO probe_cfg (k, v) VALUES (${key}, '1')`;
  return true;
}
function bump(sql: SqlFn, key: string): number {
  tables(sql);
  const rows = sql`SELECT v FROM probe_cfg WHERE k = ${key}` as { v: string }[];
  const n = (rows[0] ? Number(rows[0].v) : 0) + 1;
  sql`INSERT OR REPLACE INTO probe_cfg (k, v) VALUES (${key}, ${String(n)})`;
  return n;
}

function userMessage(text: string): UIMessage {
  return {
    id: `srv-${crypto.randomUUID()}`,
    role: "user",
    parts: [{ type: "text", text }]
  };
}
function summarizeResult(r: SaveMessagesResult) {
  const v = r as SaveMessagesResult & { reason?: string; error?: string };
  return {
    status: v.status,
    reason: v.reason,
    error: v.error ? String(v.error).slice(0, 160) : undefined
  };
}

/** What the probe does the same way on both agents. */
type ProbeHost = {
  chatRecovery: ChatRecoveryConfig;
  chatStreamStallTimeoutMs: number;
  messageConcurrency: MessageConcurrency;
};

function applyRuntimeConfig(self: ProbeHost, cfg: ProbeConfig, sql: SqlFn) {
  self.chatStreamStallTimeoutMs = cfg.stallMs ?? 3000;
  if (cfg.concurrency !== undefined)
    self.messageConcurrency = cfg.concurrency as MessageConcurrency;
  self.chatRecovery = {
    maxAttempts: cfg.maxAttempts ?? 4,
    stableTimeoutMs: cfg.stableTimeoutMs ?? 10_000,
    terminalMessage: "PROBE-TERMINAL: recovery gave up.",
    onExhausted: (ctx) => {
      note(sql, {
        onExhausted: true,
        reason: ctx.reason,
        attempt: ctx.attempt
      });
    }
  };
}

function recordResponse(sql: SqlFn, r: ChatResponseResult) {
  tables(sql);
  const error = (r as { error?: string }).error;
  sql`INSERT INTO probe_responses (at, json) VALUES (${Date.now()}, ${JSON.stringify(
    {
      status: r.status,
      continuation: r.continuation,
      requestId: r.requestId,
      parts: r.message?.parts?.length ?? 0,
      error: error ? String(error).slice(0, 100) : undefined
    }
  )})`;
}

/** onChatRecovery for both agents: note it, stop or decline as configured. */
function onRecovery(
  sql: SqlFn,
  ctx: ChatRecoveryContext,
  stop: (requestId: string) => void
): ChatRecoveryOptions {
  const cfg = readConfig(sql);
  const c = ctx as ChatRecoveryContext & {
    recoveryKind?: string;
    attempt?: number;
    requestId?: string;
  };
  note(sql, { onChatRecovery: true, kind: c.recoveryKind, attempt: c.attempt });
  const n = bump(sql, "recoveryCalls");
  if (cfg.stopInOnChatRecovery && c.requestId) {
    note(sql, { stopInRoute: c.requestId.slice(0, 14) });
    stop(c.requestId);
  }
  if (cfg.declineFromCall !== undefined && n >= cfg.declineFromCall)
    return { continue: false };
  return cfg.recoveryContinue === false ? { continue: false } : {};
}

/** Throws a recovery attempt's continueLastTurn as configured. */
function beforeContinue(sql: SqlFn, options: SaveMessagesOptions | undefined) {
  const cfg = readConfig(sql);
  if (!options?.signal) return;
  if (cfg.throwInRecoveryContinue) {
    note(sql, { threwInRecoveryContinue: true });
    throw new Error("probe: recovery attempt threw");
  }
  if (cfg.transientInRecoveryOnce && flagOnce(sql, "transientThrown")) {
    note(sql, { threwTransient: true });
    throw new Error("Network connection lost.");
  }
}

/** Throws once from a recovery attempt's stable wait as configured. */
function beforeStableWait(
  sql: SqlFn,
  options: { timeout?: number } | undefined
) {
  const cfg = readConfig(sql);
  if (
    cfg.transientInStableWaitOnce &&
    options?.timeout !== undefined &&
    flagOnce(sql, "stableTransientThrown")
  ) {
    note(sql, { threwTransientInStableWait: true });
    throw new Error("Network connection lost.");
  }
}

async function save(
  agent: {
    saveMessages(
      m: UIMessage[],
      o: SaveMessagesOptions
    ): Promise<SaveMessagesResult>;
  },
  text: string
) {
  try {
    return summarizeResult(await agent.saveMessages([userMessage(text)], {}));
  } catch (e) {
    return { threw: String(e).slice(0, 160) };
  }
}

// ── AIChatAgent ────────────────────────────────────────────────────────────

export class ProbeChat extends AIChatAgent<Env> {
  override observability = recordingObservability(this.sql.bind(this) as SqlFn);
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    applyRuntimeConfig(this, readConfig(this.s), this.s);
  }
  private get s(): SqlFn {
    return this.sql.bind(this) as SqlFn;
  }

  async onChatMessage(_onFinish: unknown, options?: OnChatMessageOptions) {
    const cfg = readConfig(this.s);
    if (cfg.abortAllInOnChatMessageMs !== undefined) {
      await sleep(cfg.abortAllInOnChatMessageMs);
      note(this.s, {
        abortAllInOnChatMessage: true,
        signalAbortedBefore: options?.abortSignal?.aborted ?? null
      });
      this.abortAllRequests();
      note(this.s, {
        signalAbortedAfter: options?.abortSignal?.aborted ?? null
      });
    }
    const tools: ToolSet = {
      ...serverTools(cfg),
      ...createToolsFromClientSchemas(options?.clientTools)
    };
    const result = streamText({
      model: fakeModel(this.s),
      system: "fake",
      messages: await convertToModelMessages(this.messages),
      tools,
      abortSignal: cfg.passSignal === false ? undefined : options?.abortSignal,
      stopWhen: isStepCount(6),
      ...(cfg.maxRetries !== undefined && { maxRetries: cfg.maxRetries })
    });
    return result.toUIMessageStreamResponse();
  }

  protected override onChatResponse(result: ChatResponseResult) {
    recordResponse(this.s, result);
  }
  protected override async onChatRecovery(ctx: ChatRecoveryContext) {
    return onRecovery(this.s, ctx, (id) =>
      this.abortRequest(id, "probe stop in route")
    );
  }
  protected override async continueLastTurn(
    body?: Record<string, unknown>,
    options?: SaveMessagesOptions
  ) {
    beforeContinue(this.s, options);
    return super.continueLastTurn(body, options);
  }
  protected override async waitUntilStable(options?: {
    timeout?: number;
    pendingInteraction?: () => boolean;
  }) {
    beforeStableWait(this.s, options);
    return super.waitUntilStable(options);
  }

  async probeSetConfig(cfg: ProbeConfig) {
    writeConfig(this.s, cfg);
    applyRuntimeConfig(this, cfg, this.s);
    return cfg;
  }
  async probeState() {
    return {
      messages: this.messages,
      schedules: (await this.listSchedules()).length,
      ...readLog(this.s)
    };
  }
  async probeAbort() {
    this.ctx.abort("probe: forced reset");
  }
  async probeSave(text: string) {
    return save(this, text);
  }
  async probeContinue() {
    try {
      return summarizeResult(await this.continueLastTurn());
    } catch (e) {
      return { threw: String(e).slice(0, 160) };
    }
  }
  async probeAbortAll() {
    this.abortAllRequests();
  }
}

// ── Think ──────────────────────────────────────────────────────────────────

export class ProbeThink extends Think<Env> {
  override observability = recordingObservability(this.sql.bind(this) as SqlFn);
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const cfg = readConfig(this.s);
    applyRuntimeConfig(this, cfg, this.s);
    this.contextOverflow = cfg.overflow ? { reactive: true } : undefined;
  }
  private get s(): SqlFn {
    return this.sql.bind(this) as SqlFn;
  }

  override getModel() {
    return fakeModel(this.s);
  }
  override getSystemPrompt() {
    return "fake";
  }
  override getTools(): ToolSet {
    return serverTools(readConfig(this.s));
  }
  override getActions() {
    return {
      pauseAction: action({
        name: "pauseAction",
        description: "A durable-pause action awaiting human approval",
        inputSchema: z.object({ message: z.string() }),
        kind: "durable-pause",
        approvalSummary: "Approve pause action",
        execute: async ({ message }: { message: string }) =>
          `paused-exec: ${message}`
      })
    };
  }
  override beforeTurn(): TurnConfig {
    const cfg = readConfig(this.s);
    return {
      activeTools: [
        "getWeather",
        "deleteFile",
        "getUserLocation",
        "getUserTimezone",
        "pauseAction"
      ],
      ...(cfg.maxRetries !== undefined && { maxRetries: cfg.maxRetries })
    };
  }
  override configureSession(session: Session): Session {
    return session.onCompaction(async (messages: SessionMessage[]) => {
      const cfg = readConfig(this.s);
      note(this.s, { compaction: "start", n: messages.length });
      this.onCompactionStart?.();
      this.onCompactionStart = undefined;
      if (cfg.compactionDelayMs) await sleep(cfg.compactionDelayMs);
      if (cfg.compactionNoOp || messages.length < 2) {
        note(this.s, { compaction: "noop" });
        return null;
      }
      note(this.s, { compaction: "done" });
      return {
        summary: "compacted-summary",
        fromMessageId: messages[0].id,
        toMessageId: messages[messages.length - 2].id
      };
    });
  }
  override classifyChatError(error: unknown): ChatErrorClassification | void {
    const cfg = readConfig(this.s);
    const text = describeError(error);
    note(this.s, { classify: text.slice(0, 160) });
    if (/context_length_exceeded|maximum context length/i.test(text))
      return "context_overflow";
    if (
      cfg.classify &&
      cfg.classify !== "none" &&
      /429|rate|Too Many|retry/i.test(text)
    )
      return cfg.classify;
  }
  override onChatResponse(result: ChatResponseResult) {
    recordResponse(this.s, result);
  }
  protected override async onChatRecovery(ctx: ChatRecoveryContext) {
    return onRecovery(this.s, ctx, (id) =>
      this.abortRequest(id, "probe stop in route")
    );
  }
  protected override async continueLastTurn(
    body?: Record<string, unknown>,
    options?: SaveMessagesOptions
  ) {
    beforeContinue(this.s, options);
    return super.continueLastTurn(body, options);
  }
  protected override async waitUntilStable(options?: {
    timeout?: number;
    pendingInteraction?: () => boolean;
  }) {
    beforeStableWait(this.s, options);
    return super.waitUntilStable(options);
  }

  async probeSetConfig(cfg: ProbeConfig) {
    writeConfig(this.s, cfg);
    applyRuntimeConfig(this, cfg, this.s);
    this.contextOverflow = cfg.overflow ? { reactive: true } : undefined;
    return cfg;
  }
  async probeState() {
    return {
      messages: await this.getMessages(),
      schedules: (await this.listSchedules()).length,
      ...readLog(this.s)
    };
  }
  async probeAbort() {
    this.ctx.abort("probe: forced reset");
  }
  async probeSave(text: string) {
    return save(this, text);
  }
  async probeContinue() {
    try {
      return summarizeResult(await this.continueLastTurn());
    } catch (e) {
      return { threw: String(e).slice(0, 160) };
    }
  }
  async probeAbortAll() {
    this.abortAllRequests();
  }
  async probePending() {
    try {
      return await this.pendingApprovals();
    } catch (e) {
      return { threw: String(e).slice(0, 160) };
    }
  }
  async probeApprove(executionId: string) {
    try {
      const out = await this.approveExecution(executionId);
      return { out: JSON.stringify(out).slice(0, 200) };
    } catch (e) {
      return { threw: String(e).slice(0, 160) };
    }
  }
  /** Called once when a compaction starts; set by `probeRpcChat`. */
  private onCompactionStart?: () => void;

  /** Think.chat() with an in-isolate callback; cancel it when compaction starts if asked. */
  async probeRpcChat(text: string, opts: { stopOnCompaction?: boolean } = {}) {
    const ac = new AbortController();
    const seen: string[] = [];
    if (opts.stopOnCompaction) this.onCompactionStart = () => ac.abort();
    const callback: StreamCallback = {
      onStart: () => {
        seen.push("<start>");
      },
      onEvent: (json: string) => {
        try {
          const t = (JSON.parse(json) as { type?: string }).type ?? "?";
          if (seen.at(-1) !== t) seen.push(t);
        } catch {
          seen.push("unparsed");
        }
      },
      onDone: () => {
        seen.push("<done>");
      },
      onError: (error: string) => {
        seen.push(`<error:${error.slice(0, 100)}>`);
      },
      onInterrupted: () => {
        seen.push("<interrupted>");
      }
    };
    let threw: string | undefined;
    const t0 = Date.now();
    try {
      await this.chat(text, callback, { signal: ac.signal });
    } catch (e) {
      threw = String(e).slice(0, 120);
    }
    return { events: seen, threw, ms: Date.now() - t0 };
  }
}

function describeError(error: unknown): string {
  const parts: string[] = [];
  let cur: unknown = error;
  for (let i = 0; i < 4 && cur != null; i++) {
    if (typeof cur === "string") {
      parts.push(cur);
      break;
    }
    const e = cur as {
      name?: string;
      message?: string;
      statusCode?: number;
      lastError?: unknown;
      cause?: unknown;
    };
    parts.push(`${e.name ?? "?"}:${e.statusCode ?? ""}:${e.message ?? ""}`);
    cur = e.lastError ?? e.cause;
  }
  return parts.join(" <- ");
}

// ── Facets ─────────────────────────────────────────────────────────────────

/** A hub whose ProbeChat and ProbeThink children are facet sub-agents. */
export class ProbeHub extends Agent<Env> {
  async probeChild(
    kind: "chat" | "think",
    name: string,
    method: string,
    args: unknown[]
  ): Promise<unknown> {
    const child =
      kind === "chat"
        ? await this.subAgent(ProbeChat, name)
        : await this.subAgent(ProbeThink, name);
    const call = (
      child as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>
    )[method];
    return call(...args);
  }
}

// ── Worker entry ───────────────────────────────────────────────────────────

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const key =
      request.headers.get("x-probe-key") ?? url.searchParams.get("key");
    if (!env.PROBE_KEY || key !== env.PROBE_KEY) {
      return new Response("Not found", { status: 404 });
    }
    if (url.pathname === "/ready") return new Response(`ready:${env.BUILD}`);
    const m = url.pathname.match(
      /^\/ctl\/(chat|think|fchat|fthink)\/([^/]+)\/(\w+)$/
    );
    if (m) {
      const [, cls, room, method] = m;
      const args =
        request.method === "POST" ? ((await request.json()) as unknown[]) : [];
      try {
        if (!method.startsWith("probe"))
          throw new Error(`not a probe method: ${method}`);
        if (cls === "fchat" || cls === "fthink") {
          const hub = await getAgentByName(env.ProbeHub, `h-${room}`);
          const value = await hub.probeChild(
            cls === "fchat" ? "chat" : "think",
            room,
            method,
            args
          );
          return Response.json({ ok: true, value: value ?? null });
        }
        const stub =
          cls === "chat"
            ? await getAgentByName(env.ProbeChat, room)
            : await getAgentByName(env.ProbeThink, room);
        const call = (
          stub as unknown as Record<
            string,
            (...a: unknown[]) => Promise<unknown>
          >
        )[method];
        const value = await call(...args);
        return Response.json({ ok: true, value: value ?? null });
      } catch (e) {
        return Response.json({ ok: false, error: String(e).slice(0, 300) });
      }
    }
    return (
      (await routeAgentRequest(request, env)) ||
      new Response("Not found", { status: 404 })
    );
  }
};
