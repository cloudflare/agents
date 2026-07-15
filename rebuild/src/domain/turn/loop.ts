import { AbortedError, TimeoutError, toErrorValue } from "../../kernel/errors.js";
import type { EventBus } from "../../kernel/events.js";
import type { IdSource } from "../../kernel/ids.js";
import type { Clock } from "../../ports/clock.js";
import type {
  ModelCallSettings,
  ModelChunk,
  ModelClient,
  ModelMessage,
  ModelRequest,
  ToolDescriptor,
} from "../../ports/model.js";
import type { ChatMessage } from "../messages/model.js";
import { toModelMessages } from "../messages/model.js";
import { repairTranscript } from "../messages/repair.js";
import type { AssembledTools, ToolHooks } from "../tools/registry.js";
import { toDescriptor, type ToolSet } from "../tools/types.js";
import type { UiChunk } from "../conversation/chunks.js";

// ---------------------------------------------------------------------------
// Public types (audit 09 §1)
// ---------------------------------------------------------------------------

export interface TurnContext {
  requestId: string;
  trigger: "websocket" | "chat" | "save" | "submission" | "continuation" | "schedule";
  continuation: boolean;
  channelId?: string;
  /** Full history incl. new input. */
  messages: ReadonlyArray<ChatMessage>;
}

export interface TurnConfig {
  model?: ModelClient;
  system?: string;
  /** Override the assembled prompt messages entirely. */
  messages?: ModelMessage[];
  /** ADDITIVE merge — extra tools offered alongside the AssembledTools. */
  tools?: ToolSet;
  activeTools?: string[];
  toolChoice?: "auto" | "none" | { toolName: string };
  maxSteps?: number;
  /** Composed with maxSteps — can stop earlier, never later. */
  stopWhen?: (ctx: { steps: StepResult[] }) => boolean;
  sendReasoning?: boolean;
  settings?: ModelCallSettings;
  /** Per-turn override of the stall watchdog (0 = off). */
  stallTimeoutMs?: number;
}

export interface StepConfig {
  system?: string;
  messages?: ModelMessage[];
  activeTools?: string[];
  toolChoice?: TurnConfig["toolChoice"];
  model?: ModelClient;
  settings?: ModelCallSettings;
}

export interface StepResult {
  stepNumber: number;
  text: string;
  reasoning: string;
  toolCalls: Array<{ toolCallId: string; toolName: string; input: unknown }>;
  toolResults: Array<{ toolCallId: string; output: unknown; isError: boolean }>;
  finishReason: string;
  usage?: { inputTokens?: number; outputTokens?: number };
}

export interface TurnHooks extends ToolHooks {
  beforeTurn?: (ctx: TurnContext) => void | TurnConfig | Promise<void | TurnConfig>;
  beforeStep?: (ctx: {
    stepNumber: number;
    messages: ModelMessage[];
  }) => void | StepConfig | Promise<void | StepConfig>;
  onStepFinish?: (ctx: StepResult) => void | Promise<void>;
  onChunk?: (ctx: { chunk: ModelChunk }) => void | Promise<void>;
}

export type TurnOutcome =
  | { kind: "completed"; steps: StepResult[]; finishReason: string }
  | {
      kind: "suspended";
      reason: "client-tool" | "approval" | "durable-pause";
      pending: Array<{ toolCallId: string; toolName: string; input: unknown }>;
      steps: StepResult[];
    }
  | { kind: "aborted"; reason?: string; steps: StepResult[] }
  | { kind: "error"; error: unknown; stalled?: boolean; steps: StepResult[] };

export interface TurnEngine {
  run(args: {
    context: TurnContext;
    system: string;
    tools: AssembledTools;
    model: ModelClient;
    /** Pre-resolved channel/default config (beforeTurn's return wins over it). */
    config?: TurnConfig;
    hooks?: TurnHooks;
    /** Think fans out: accumulator + stream buffer + connections. */
    emit: (chunk: UiChunk) => void;
    signal?: AbortSignal;
  }): Promise<TurnOutcome>;
}

/** Distinguished error for the stall watchdog (code "timeout"). */
export class StallError extends TimeoutError {
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`Model stream stalled: no chunk received for ${timeoutMs}ms`);
    this.timeoutMs = timeoutMs;
  }
}

const DEFAULT_MAX_STEPS = 10;
const TERMINAL_FINISH_REASONS = new Set(["stop", "length", "content-filter", "error"]);

// ---------------------------------------------------------------------------
// Config resolution: defaults <- pre-resolved config <- beforeTurn (wins)
// ---------------------------------------------------------------------------

function mergeConfig(base: TurnConfig, overlay: TurnConfig | void | undefined): TurnConfig {
  if (!overlay) return base;
  const merged: TurnConfig = { ...base };
  if (overlay.model !== undefined) merged.model = overlay.model;
  if (overlay.system !== undefined) merged.system = overlay.system;
  if (overlay.messages !== undefined) merged.messages = overlay.messages;
  if (overlay.activeTools !== undefined) merged.activeTools = overlay.activeTools;
  if (overlay.toolChoice !== undefined) merged.toolChoice = overlay.toolChoice;
  if (overlay.maxSteps !== undefined) merged.maxSteps = overlay.maxSteps;
  if (overlay.stopWhen !== undefined) merged.stopWhen = overlay.stopWhen;
  if (overlay.sendReasoning !== undefined) merged.sendReasoning = overlay.sendReasoning;
  if (overlay.stallTimeoutMs !== undefined) merged.stallTimeoutMs = overlay.stallTimeoutMs;
  // Tools are an ADDITIVE merge, never a replacement.
  if (overlay.tools !== undefined) merged.tools = { ...base.tools, ...overlay.tools };
  if (overlay.settings !== undefined) merged.settings = { ...base.settings, ...overlay.settings };
  return merged;
}

// ---------------------------------------------------------------------------
// Stall watchdog: an inactivity timer spanning the gap between model chunks.
// Injectable setTimeout/clearTimeout so tests can fake it.
// ---------------------------------------------------------------------------

interface Watchdog {
  arm(): void;
  disarm(): void;
  /** Rejects with StallError when the armed timer fires. */
  fired: Promise<never>;
}

function createWatchdog(
  timeoutMs: number,
  onStall: (err: StallError) => void,
  setTimeoutFn: typeof setTimeout,
  clearTimeoutFn: typeof clearTimeout
): Watchdog {
  let handle: ReturnType<typeof setTimeout> | undefined;
  let reject!: (err: unknown) => void;
  const fired = new Promise<never>((_resolve, rej) => {
    reject = rej;
  });
  // The rejection is always consumed by the race in the stream loop while the
  // timer is armed; this no-op branch just guards against a stray unhandled-
  // rejection warning if an engine bug ever left it unobserved.
  fired.catch(() => {});

  function disarm(): void {
    if (handle !== undefined) {
      clearTimeoutFn(handle);
      handle = undefined;
    }
  }

  return {
    arm(): void {
      disarm();
      handle = setTimeoutFn(() => {
        const err = new StallError(timeoutMs);
        onStall(err);
        reject(err);
      }, timeoutMs);
    },
    disarm,
    fired,
  };
}

// ---------------------------------------------------------------------------
// Extra-tool plumbing (TurnConfig.tools additive merge)
// ---------------------------------------------------------------------------

interface ToolRouter {
  descriptors(activeTools?: string[]): ToolDescriptor[];
  isClientTool(name: string): boolean;
  needsApproval(name: string, input: unknown): Promise<boolean>;
  execute(
    name: string,
    input: unknown,
    ctx: { toolCallId: string; requestId: string; messages: ReadonlyArray<ChatMessage>; signal: AbortSignal; stepNumber: number }
  ): Promise<{ output: unknown; isError: boolean }>;
}

/**
 * Routes tool operations to the AssembledTools, falling back to the turn
 * config's extra tools for names the assembly doesn't know. On a name
 * collision the assembled (server-configured) tool wins.
 */
function createToolRouter(assembled: AssembledTools, extra: ToolSet): ToolRouter {
  const assembledNames = new Set(Object.keys(assembled.tools));

  function extraTool(name: string) {
    return assembledNames.has(name) ? undefined : extra[name];
  }

  return {
    descriptors(activeTools?: string[]): ToolDescriptor[] {
      const out = assembled.descriptors(activeTools);
      const active = activeTools ? new Set(activeTools) : undefined;
      for (const [name, t] of Object.entries(extra)) {
        if (assembledNames.has(name)) continue;
        if (active && !active.has(name)) continue;
        out.push(toDescriptor(name, t));
      }
      return out;
    },

    isClientTool(name: string): boolean {
      if (assembledNames.has(name)) return assembled.isClientTool(name);
      const t = extraTool(name);
      return t !== undefined && t.execute === undefined;
    },

    async needsApproval(name: string, input: unknown): Promise<boolean> {
      if (assembledNames.has(name)) return assembled.needsApproval(name, input);
      const t = extraTool(name);
      if (!t || t.needsApproval === undefined) return false;
      if (typeof t.needsApproval === "function") return await t.needsApproval(input);
      return t.needsApproval;
    },

    async execute(name, input, ctx) {
      const t = extraTool(name);
      if (t?.execute) {
        try {
          const output = await t.execute(input, ctx);
          return { output, isError: false };
        } catch (err) {
          if (err instanceof AbortedError) throw err;
          return { output: { error: toErrorValue(err) }, isError: true };
        }
      }
      // Assembled tool, or unknown name (execute returns a ToolNotFoundError value).
      return assembled.execute(name, input, ctx);
    },
  };
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

interface CollectedStep {
  text: string;
  reasoning: string;
  toolCalls: Array<{ toolCallId: string; toolName: string; input: unknown }>;
  finishReason: string;
  usage?: { inputTokens?: number; outputTokens?: number };
}

export function createTurnEngine(deps: {
  clock: Clock;
  ids: IdSource;
  bus: EventBus;
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
}): TurnEngine {
  const setTimeoutFn = deps.setTimeoutFn ?? setTimeout;
  const clearTimeoutFn = deps.clearTimeoutFn ?? clearTimeout;

  return {
    async run(args): Promise<TurnOutcome> {
      const hooks = args.hooks ?? {};
      // Stamp part ids onto delta chunks, turn-scoped: consecutive deltas of
      // one kind share an id; a kind change (or any intervening chunk) starts
      // a new part -> next id. Matches the original UI-stream convention
      // ("t1", "t2", ...) that clients key streaming text parts by
      // (ISSUE-018 / client compat).
      let partSeq = 0;
      let openDelta: { kind: "text-delta" | "reasoning-delta"; id: string } | null = null;
      const emit: (chunk: UiChunk) => void = (chunk) => {
        if (chunk.type === "text-delta" || chunk.type === "reasoning-delta") {
          if (openDelta === null || openDelta.kind !== chunk.type) {
            partSeq += 1;
            openDelta = { kind: chunk.type, id: `t${partSeq}` };
          }
          // Field order matters downstream: the wire serializes chunks, and
          // the original's byte-replayed bodies are {type, id, delta}.
          args.emit({ type: chunk.type, id: openDelta.id, delta: chunk.delta });
          return;
        }
        openDelta = null;
        args.emit(chunk);
      };
      const steps: StepResult[] = [];

      // Internal controller: the external signal, a stall, or a replace all
      // funnel through it so the model stream and tools see one signal.
      const controller = new AbortController();
      const external = args.signal;
      const onExternalAbort = (): void => {
        controller.abort(new AbortedError(abortReason(external) ?? "Turn aborted"));
      };
      if (external) {
        if (external.aborted) {
          return { kind: "aborted", reason: abortReason(external), steps };
        }
        external.addEventListener("abort", onExternalAbort, { once: true });
      }

      try {
        // 1. Resolve config: defaults <- pre-resolved config <- beforeTurn.
        let config = mergeConfig({}, args.config);
        if (hooks.beforeTurn) {
          config = mergeConfig(config, await hooks.beforeTurn(args.context));
        }

        const turnModel = config.model ?? args.model;
        const turnSystem = config.system ?? args.system;
        const maxSteps = config.maxSteps ?? DEFAULT_MAX_STEPS;
        const sendReasoning = config.sendReasoning ?? true;
        const stallTimeoutMs = config.stallTimeoutMs ?? 0;
        const router = createToolRouter(args.tools, config.tools ?? {});

        // Assembled prompt: repaired history -> model messages, unless the
        // config overrides the prompt messages wholesale.
        let messages: ModelMessage[] = config.messages
          ? [...config.messages]
          : toModelMessages(repairTranscript([...args.context.messages]).messages);

        emit({ type: "start", messageId: deps.ids.newId("msg") });

        let finishReason = "unknown";

        for (let stepNumber = 0; ; stepNumber++) {
          // 2a. beforeStep may override step-scoped settings.
          const stepConfig = hooks.beforeStep
            ? ((await hooks.beforeStep({ stepNumber, messages })) ?? undefined)
            : undefined;
          const stepModel = stepConfig?.model ?? turnModel;
          const stepSystem = stepConfig?.system ?? turnSystem;
          const stepMessages = stepConfig?.messages ?? messages;
          const stepActiveTools = stepConfig?.activeTools ?? config.activeTools;
          const stepToolChoice = stepConfig?.toolChoice ?? config.toolChoice;
          const stepSettings = stepConfig?.settings ?? config.settings;

          // 2b. Build the request and stream the model.
          const request: ModelRequest = {
            messages: stepMessages,
            tools: router.descriptors(stepActiveTools),
            signal: controller.signal,
          };
          if (stepSystem !== undefined) request.system = stepSystem;
          if (stepToolChoice !== undefined) request.toolChoice = stepToolChoice;
          if (stepSettings !== undefined) request.settings = stepSettings;

          const collected = await consumeStream(stepModel.stream(request), {
            emit,
            hooks,
            sendReasoning,
            stallTimeoutMs,
            setTimeoutFn,
            clearTimeoutFn,
            onStall: (err) => {
              deps.bus.emit("chat:stream:stalled", {
                requestId: args.context.requestId,
                timeoutMs: err.timeoutMs,
              });
              controller.abort(err);
            },
          });

          // 2e. Execute tool calls sequentially; client/approval tools suspend.
          const toolResults: StepResult["toolResults"] = [];
          for (let i = 0; i < collected.toolCalls.length; i++) {
            const call = collected.toolCalls[i]!;

            if (router.isClientTool(call.toolName)) {
              emit({
                type: "tool-input-available",
                toolCallId: call.toolCallId,
                toolName: call.toolName,
                input: call.input,
                executor: "client",
              });
              steps.push(partialStep(stepNumber, collected, toolResults));
              return { kind: "suspended", reason: "client-tool", pending: collected.toolCalls.slice(i), steps };
            }

            if (await router.needsApproval(call.toolName, call.input)) {
              emit({
                type: "tool-approval-requested",
                toolCallId: call.toolCallId,
                toolName: call.toolName,
                input: call.input,
              });
              steps.push(partialStep(stepNumber, collected, toolResults));
              return { kind: "suspended", reason: "approval", pending: collected.toolCalls.slice(i), steps };
            }

            emit({
              type: "tool-input-available",
              toolCallId: call.toolCallId,
              toolName: call.toolName,
              input: call.input,
              executor: "server",
            });
            const { output, isError } = await router.execute(call.toolName, call.input, {
              toolCallId: call.toolCallId,
              requestId: args.context.requestId,
              messages: args.context.messages,
              signal: controller.signal,
              stepNumber,
            });
            emit({ type: "tool-output-available", toolCallId: call.toolCallId, output, isError });
            toolResults.push({ toolCallId: call.toolCallId, output, isError });
          }

          // 2f. Step finished.
          const step: StepResult = partialStep(stepNumber, collected, toolResults);
          steps.push(step);
          if (hooks.onStepFinish) await hooks.onStepFinish(step);

          // 2g. Stop conditions (composed; finishReason preserved).
          finishReason = collected.finishReason;
          const terminal = TERMINAL_FINISH_REASONS.has(finishReason);
          const capped = steps.length >= maxSteps;
          const stopRequested = config.stopWhen ? config.stopWhen({ steps }) === true : false;
          const nothingToContinue = collected.toolCalls.length === 0;
          if (terminal || capped || stopRequested || nothingToContinue) break;

          // Append this step's assistant tool-calls + tool-results so the next
          // model call sees them.
          const assistantContent: Extract<ModelMessage, { role: "assistant" }>["content"] = [];
          if (collected.text.length > 0) assistantContent.push({ type: "text", text: collected.text });
          for (const call of collected.toolCalls) {
            assistantContent.push({
              type: "tool-call",
              toolCallId: call.toolCallId,
              toolName: call.toolName,
              input: call.input,
            });
          }
          const toolNameById = new Map(collected.toolCalls.map((c) => [c.toolCallId, c.toolName]));
          const toolContent: Extract<ModelMessage, { role: "tool" }>["content"] = toolResults.map((r) => ({
            type: "tool-result",
            toolCallId: r.toolCallId,
            toolName: toolNameById.get(r.toolCallId) ?? "unknown",
            output: r.output,
            ...(r.isError ? { isError: true } : {}),
          }));
          messages = [...messages];
          if (assistantContent.length > 0) messages.push({ role: "assistant", content: assistantContent });
          if (toolContent.length > 0) messages.push({ role: "tool", content: toolContent });
        }

        // 5. Every completed turn ends with a finish UiChunk.
        emit({ type: "finish", finishReason });
        return { kind: "completed", steps, finishReason };
      } catch (err) {
        if (err instanceof StallError) {
          emit({ type: "error", errorText: err.message });
          emit({ type: "finish", finishReason: "error" });
          return { kind: "error", error: err, stalled: true, steps };
        }
        if (err instanceof AbortedError || controller.signal.aborted) {
          // 3. Chunks emitted so far remain valid; no further chunks.
          const reason = err instanceof Error ? err.message : abortReason(controller.signal);
          return reason === undefined ? { kind: "aborted", steps } : { kind: "aborted", reason, steps };
        }
        // 4. Model/hook errors propagate with the raw error attached.
        emit({ type: "error", errorText: err instanceof Error ? err.message : String(err) });
        emit({ type: "finish", finishReason: "error" });
        return { kind: "error", error: err, steps };
      } finally {
        external?.removeEventListener("abort", onExternalAbort);
      }
    },
  };
}

function abortReason(signal: AbortSignal | undefined): string | undefined {
  if (!signal?.aborted) return undefined;
  const reason: unknown = signal.reason;
  if (reason instanceof Error) return reason.message;
  if (typeof reason === "string") return reason;
  return undefined;
}

function partialStep(stepNumber: number, collected: CollectedStep, toolResults: StepResult["toolResults"]): StepResult {
  const step: StepResult = {
    stepNumber,
    text: collected.text,
    reasoning: collected.reasoning,
    toolCalls: collected.toolCalls,
    toolResults: [...toolResults],
    finishReason: collected.finishReason,
  };
  if (collected.usage !== undefined) step.usage = collected.usage;
  return step;
}

/**
 * Drains one model stream: forwards text/reasoning deltas as UiChunks
 * (reasoning gated by sendReasoning), passes every raw chunk to onChunk,
 * collects tool calls, and guards each inter-chunk gap with the stall
 * watchdog when stallTimeoutMs > 0.
 */
async function consumeStream(
  stream: AsyncIterable<ModelChunk>,
  opts: {
    emit: (chunk: UiChunk) => void;
    hooks: TurnHooks;
    sendReasoning: boolean;
    stallTimeoutMs: number;
    setTimeoutFn: typeof setTimeout;
    clearTimeoutFn: typeof clearTimeout;
    onStall: (err: StallError) => void;
  }
): Promise<CollectedStep> {
  const collected: CollectedStep = { text: "", reasoning: "", toolCalls: [], finishReason: "unknown" };
  const watchdog =
    opts.stallTimeoutMs > 0
      ? createWatchdog(opts.stallTimeoutMs, opts.onStall, opts.setTimeoutFn, opts.clearTimeoutFn)
      : undefined;

  const iterator = stream[Symbol.asyncIterator]();
  try {
    for (;;) {
      watchdog?.arm();
      const nextPromise = iterator.next();
      // If the watchdog wins the race, the losing next() will later reject
      // (the stream is aborted); observe it so the rejection isn't unhandled.
      nextPromise.catch(() => {});
      const result = watchdog ? await Promise.race([nextPromise, watchdog.fired]) : await nextPromise;
      watchdog?.disarm();
      if (result.done) break;

      const chunk = result.value;
      switch (chunk.type) {
        case "text-delta":
          collected.text += chunk.text;
          opts.emit({ type: "text-delta", delta: chunk.text });
          break;
        case "reasoning-delta":
          collected.reasoning += chunk.text;
          if (opts.sendReasoning) opts.emit({ type: "reasoning-delta", delta: chunk.text });
          break;
        case "tool-call":
          collected.toolCalls.push({ toolCallId: chunk.toolCallId, toolName: chunk.toolName, input: chunk.input });
          break;
        case "finish":
          collected.finishReason = chunk.finishReason;
          if (chunk.usage !== undefined) collected.usage = chunk.usage;
          break;
      }
      if (opts.hooks.onChunk) await opts.hooks.onChunk({ chunk });
    }
  } finally {
    watchdog?.disarm();
  }
  return collected;
}
