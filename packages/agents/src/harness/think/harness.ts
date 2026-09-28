import {
  convertToModelMessages,
  generateId,
  stepCountIs,
  streamText,
  type ModelMessage,
  type Tool,
  type ToolSet,
  type UIMessage,
  type UIMessageChunk
} from "ai";
import type {
  DriverHandle,
  DriverOperation,
  DriverStep,
  DriverSubmission
} from "../../driver";
import { LifecycleCapability } from "../../lifecycle";
import type { Session, SessionMessage } from "../../sessions";
import { ThinkStore } from "./store";
import {
  asToolPart,
  findToolPart,
  lastStep,
  nextAction,
  openToolParts,
  toolNameOf,
  updateToolPart,
  type ToolPart
} from "./transcript";
import type {
  ThinkHarnessOptions,
  ThinkToolCall,
  ThinkToolRecovery,
  ThinkToolResult,
  ThinkTurnConfig,
  ThinkTurnContext,
  ThinkTurnEnd,
  ThinkTurnInput,
  ThinkTurnReceipt,
  ThinkTurnRecord,
  ThinkTurnStatus
} from "./types";

type TurnResult = { readonly status: ThinkTurnStatus };

const INTERRUPTED_TOOL =
  "The tool call was interrupted before it finished. It may or may not have taken effect.";
const STOPPED_TOOL = "The turn was stopped before this tool call finished.";

/**
 * Think's turn loop as a driver runtime.
 *
 * Each chat is one driver queue of turns. One step of a turn does one
 * thing, chosen from the transcript: call the model once, run one tool
 * call, or settle one tool part. Approvals and client tools park the turn
 * until {@link ThinkHarness.answer} or {@link ThinkHarness.resolveTool}.
 *
 * @experimental Not documented yet. It tracks `@cloudflare/think`'s test
 * suite and may change in any release until that suite passes on it.
 */
export class ThinkHarness extends LifecycleCapability {
  readonly #options: ThinkHarnessOptions;
  readonly #driver: DriverHandle<ThinkTurnInput>;
  /** `beforeTurn` results, per turn, for this isolate's lifetime. */
  readonly #turnConfig = new Map<string, ThinkTurnConfig>();
  readonly #waiters = new Map<string, Set<(end: ThinkTurnEnd) => void>>();
  #store: ThinkStore | undefined;

  constructor(options: ThinkHarnessOptions) {
    const id = options.id ?? "think";
    super(`think-harness:${id}`);
    this.#options = options;
    this.#driver = options.driver.register<ThinkTurnInput, TurnResult>(
      id,
      {
        step: (operation, signal) => this.#step(operation, signal),
        stop: (operation) => this.#stopTurn(operation)
      },
      { onFail: (operation, error) => this.#failTurn(operation, error.message) }
    );
  }

  // ── Public API ────────────────────────────────────────────────────

  /** Queue a turn in a chat. Its `messages` join the transcript when it starts. */
  async submit(
    chat: string,
    input: ThinkTurnInput = {},
    options: { readonly turnId?: string } = {}
  ): Promise<ThinkTurnReceipt> {
    const receipt = await this.#driver.submit(chat, input, {
      id: options.turnId
    });
    return { turnId: receipt.id, chat, accepted: receipt.accepted };
  }

  /** Answer a tool call that is waiting for approval. */
  async answer(
    chat: string,
    toolCallId: string,
    decision: { readonly approved: boolean; readonly reason?: string }
  ): Promise<boolean> {
    await this.lifecycle.ready();
    const updated = await this.#updateOpenPart(chat, toolCallId, (part) =>
      part.state === "approval-requested"
        ? {
            ...part,
            state: "approval-responded",
            approval: {
              id: part.approval?.id ?? generateId(),
              approved: decision.approved,
              ...(decision.reason !== undefined
                ? { reason: decision.reason }
                : {})
            }
          }
        : undefined
    );
    if (updated) await this.#driver.wake(chat);
    return updated;
  }

  /** Record the result of a tool the client runs. */
  async resolveTool(
    chat: string,
    toolCallId: string,
    result: ThinkToolResult
  ): Promise<boolean> {
    await this.lifecycle.ready();
    const turn = this.#turns().running(chat);
    if (!turn) return false;
    const updated = await this.#updateOpenPart(chat, toolCallId, (part) =>
      part.state === "input-available" ? settledPart(part, result) : undefined
    );
    if (!updated) return false;
    this.#emit(this.#context(turn, undefined), resultChunk(toolCallId, result));
    await this.#driver.wake(chat);
    return true;
  }

  /** Stop one turn, queued or running. */
  stop(turnId: string): Promise<boolean> {
    return this.#driver.stop(turnId);
  }

  /** Stop every queued and running turn in a chat. */
  async stopChat(chat: string): Promise<number> {
    let stopped = 0;
    for (const turn of await this.#driver.pending(chat)) {
      if (await this.#driver.stop(turn.id)) stopped += 1;
    }
    return stopped;
  }

  /** Queued and running turns in a chat, oldest first. */
  pending(chat: string): Promise<DriverSubmission<ThinkTurnInput>[]> {
    return this.#driver.pending(chat);
  }

  turn(turnId: string): ThinkTurnRecord | undefined {
    return this.#turns().turn(turnId);
  }

  activeTurn(chat: string): ThinkTurnRecord | undefined {
    return this.#turns().running(chat);
  }

  /** Resolve when the turn ends. */
  async waitForTurn(turnId: string): Promise<ThinkTurnEnd> {
    // Starting the Lifecycle is what resumes a queue after an eviction.
    await this.lifecycle.ready();
    const turn = this.#turns().turn(turnId);
    if (turn && turn.status !== "running") {
      return this.#endOf(turn, turn.status, turn.error ?? undefined);
    }
    return new Promise((resolve) => {
      let waiters = this.#waiters.get(turnId);
      if (!waiters) {
        waiters = new Set();
        this.#waiters.set(turnId, waiters);
      }
      waiters.add(resolve);
    });
  }

  /** Forget the harness's records for a chat. Its transcript is the caller's. */
  clear(chat: string): void {
    this.#turns().clear(chat);
  }

  // ── Driver runtime ────────────────────────────────────────────────

  async #step(
    operation: DriverOperation<ThinkTurnInput>,
    signal: AbortSignal
  ): Promise<DriverStep<TurnResult>> {
    const turn =
      this.#turns().turn(operation.id) ?? (await this.#begin(operation));
    if (turn.status !== "running") {
      return { then: "done", result: { status: turn.status } };
    }

    const context = this.#context(turn, operation.input.body);
    const session = this.#session(turn.chat);
    const config = await this.#config(context);
    const tools = config.tools ?? (await this.#options.tools?.(context)) ?? {};
    const message = await this.#message(session, turn);
    const next = nextAction(
      message,
      (name) => typeof tools[name]?.execute === "function"
    );

    switch (next.kind) {
      case "await-approval":
      case "await-client":
        return { then: "park" };
      case "deny-tool":
        await this.#settle(session, context, turn, next.part.toolCallId, {
          state: "output-denied"
        });
        return { then: "continue" };
      case "interrupted-input":
        await this.#settle(session, context, turn, next.part.toolCallId, {
          ok: false,
          error: INTERRUPTED_TOOL
        });
        return { then: "continue" };
      case "run-tool":
        await this.#runTool(session, context, turn, tools, next.part, signal);
        return { then: "continue" };
      case "finished":
        return this.#finish(context, turn, "completed");
      case "model": {
        const maxSteps = config.maxSteps ?? this.#options.maxSteps ?? 10;
        if (turn.step >= maxSteps) {
          return this.#finish(context, turn, "completed");
        }
        const error = await this.#modelStep(
          session,
          context,
          turn,
          config,
          tools,
          message,
          signal
        );
        return error === undefined
          ? { then: "continue" }
          : this.#finish(context, turn, "error", error);
      }
    }
  }

  async #begin(
    operation: DriverOperation<ThinkTurnInput>
  ): Promise<ThinkTurnRecord> {
    const session = this.#session(operation.scope);
    // Upserts by id, so a first step cut off here repeats safely.
    for (const message of operation.input.messages ?? []) {
      await session.upsertMessage(message as SessionMessage);
    }
    return this.#turns().begin(operation.id, operation.scope, generateId());
  }

  async #modelStep(
    session: Session,
    context: ThinkTurnContext,
    turn: ThinkTurnRecord,
    config: ThinkTurnConfig,
    tools: ToolSet,
    message: UIMessage | undefined,
    signal: AbortSignal
  ): Promise<string | undefined> {
    const history = (await session.getHistory()) as unknown as UIMessage[];
    const model = config.model ?? (await this.#options.model(context));
    const system = config.system ?? (await this.#options.system?.(context));
    const messages =
      config.messages ??
      (await convertToModelMessages(history, {
        tools,
        ignoreIncompleteToolCalls: true
      }));

    const result = streamText({
      model,
      ...(system !== undefined ? { system } : {}),
      messages,
      tools: toModelTools(tools),
      ...(config.activeTools ? { activeTools: config.activeTools } : {}),
      ...(config.toolChoice ? { toolChoice: config.toolChoice } : {}),
      ...(config.maxOutputTokens !== undefined
        ? { maxOutputTokens: config.maxOutputTokens }
        : {}),
      ...(config.temperature !== undefined
        ? { temperature: config.temperature }
        : {}),
      ...(config.topP !== undefined ? { topP: config.topP } : {}),
      ...(config.topK !== undefined ? { topK: config.topK } : {}),
      ...(config.providerOptions
        ? { providerOptions: config.providerOptions }
        : {}),
      // One model call per driver step: the harness runs the tools.
      stopWhen: stepCountIs(1),
      abortSignal: signal
    });

    let streamError: string | undefined;
    let response: UIMessage | undefined;
    let finishReason: string | undefined;
    for await (const chunk of result.toUIMessageStream({
      // Continuing this turn's message extends it; otherwise a new one
      // starts under the turn's stable message id.
      originalMessages: message ? history : [],
      generateMessageId: () => turn.messageId,
      sendStart: message === undefined,
      sendFinish: false,
      sendReasoning: config.sendReasoning ?? true,
      onError: (error) => {
        streamError = errorText(error);
        return streamError;
      },
      onFinish: (event) => {
        response = event.responseMessage;
        finishReason = event.finishReason;
      }
    })) {
      this.#emit(context, chunk);
    }

    const toolCalls: ThinkToolCall[] = [];
    if (response && response.parts.length > 0) {
      const approvals: UIMessageChunk[] = [];
      let persisted: UIMessage = { ...response, id: turn.messageId };
      for (const candidate of lastStep(persisted)) {
        const part = asToolPart(candidate);
        if (part?.state !== "input-available") continue;
        const call = {
          toolCallId: part.toolCallId,
          toolName: toolNameOf(part),
          input: part.input
        };
        toolCalls.push(call);
        if (await needsApproval(tools[call.toolName], call, messages)) {
          const approvalId = generateId();
          persisted = updateToolPart(persisted, part.toolCallId, (open) => ({
            ...open,
            state: "approval-requested",
            approval: { id: approvalId }
          }));
          approvals.push({
            type: "tool-approval-request",
            approvalId,
            toolCallId: part.toolCallId
          });
        }
      }
      await session.upsertMessage(persisted as SessionMessage);
      // Clients may answer as soon as they see the request, so it goes out
      // only once the part it answers is durable.
      for (const chunk of approvals) this.#emit(context, chunk);
    }

    if (signal.aborted) throw signal.reason;
    if (streamError !== undefined) return streamError;

    this.#turns().completeStep(turn.turnId);
    await this.#options.hooks?.onStepFinish?.({
      ...context,
      finishReason,
      toolCalls
    });
    return undefined;
  }

  async #runTool(
    session: Session,
    context: ThinkTurnContext,
    turn: ThinkTurnRecord,
    tools: ToolSet,
    part: ToolPart,
    signal: AbortSignal
  ): Promise<void> {
    const toolName = toolNameOf(part);
    const tool = tools[toolName];
    const call: ThinkToolCall = {
      toolCallId: part.toolCallId,
      toolName,
      input: part.input
    };
    const settle = (result: ThinkToolResult) =>
      this.#settle(session, context, turn, part.toolCallId, result);

    if (typeof tool?.execute !== "function") {
      return settle({ ok: false, error: `Tool ${toolName} is not available` });
    }
    if (this.#turns().toolInterrupted(part.toolCallId)) {
      const recovery =
        (tool as Tool & { recovery?: ThinkToolRecovery }).recovery ?? "never";
      if (recovery === "never") {
        return settle({ ok: false, error: INTERRUPTED_TOOL });
      }
    }

    const decision = await this.#options.hooks?.beforeToolCall?.({
      ...context,
      call
    });
    if (decision?.action === "block") {
      return settle({
        ok: false,
        error: decision.reason ?? `Tool ${toolName} was blocked`
      });
    }
    if (decision?.action === "substitute") {
      return settle({ ok: true, output: decision.output });
    }
    const input =
      decision?.action === "allow" && decision.input !== undefined
        ? decision.input
        : part.input;

    this.#turns().toolStarted(part.toolCallId, turn.turnId);
    let result: ThinkToolResult;
    try {
      const history = (await session.getHistory()) as unknown as UIMessage[];
      const messages = await convertToModelMessages(history, {
        tools,
        ignoreIncompleteToolCalls: true
      });
      const value = tool.execute(input as never, {
        toolCallId: part.toolCallId,
        messages,
        abortSignal: signal,
        context: undefined as never
      });
      result = {
        ok: true,
        output: await finalOutput(value, (output) =>
          this.#emit(context, {
            type: "tool-output-available",
            toolCallId: part.toolCallId,
            output,
            preliminary: true
          })
        )
      };
    } catch (error) {
      if (signal.aborted) throw error;
      result = { ok: false, error: errorText(error) };
    }
    await settle(result);
    await this.#options.hooks?.afterToolCall?.({ ...context, call, result });
  }

  async #settle(
    session: Session,
    context: ThinkTurnContext,
    turn: ThinkTurnRecord,
    toolCallId: string,
    result: ThinkToolResult | { readonly state: "output-denied" }
  ): Promise<void> {
    const message = await this.#message(session, turn);
    if (message) {
      await session.updateMessage(
        updateToolPart(message, toolCallId, (part) =>
          "state" in result
            ? { ...part, state: "output-denied" }
            : settledPart(part, result)
        ) as SessionMessage
      );
    }
    this.#turns().toolSettled(toolCallId);
    this.#emit(
      context,
      "state" in result
        ? { type: "tool-output-denied", toolCallId }
        : resultChunk(toolCallId, result)
    );
  }

  async #stopTurn(operation: DriverOperation<ThinkTurnInput>): Promise<void> {
    const store = this.#turns();
    const turn =
      store.turn(operation.id) ??
      store.begin(operation.id, operation.scope, generateId());
    if (turn.status !== "running") return;
    const context = this.#context(turn, operation.input.body);
    const session = this.#session(turn.chat);
    const message = await this.#message(session, turn);
    if (message) {
      let settled = message;
      for (const part of openToolParts(message)) {
        settled = updateToolPart(settled, part.toolCallId, (open) =>
          settledPart(open, { ok: false, error: STOPPED_TOOL })
        );
      }
      if (settled !== message) {
        await session.updateMessage(settled as SessionMessage);
      }
    }
    this.#emit(context, { type: "abort" });
    await this.#finish(context, turn, "stopped");
  }

  async #failTurn(
    operation: DriverOperation<ThinkTurnInput>,
    error: string
  ): Promise<void> {
    const store = this.#turns();
    const turn =
      store.turn(operation.id) ??
      store.begin(operation.id, operation.scope, generateId());
    if (turn.status !== "running") return;
    const context = this.#context(turn, operation.input.body);
    this.#emit(context, { type: "error", errorText: error });
    await this.#finish(context, turn, "error", error);
  }

  async #finish(
    context: ThinkTurnContext,
    turn: ThinkTurnRecord,
    status: ThinkTurnStatus,
    error?: string
  ): Promise<DriverStep<TurnResult>> {
    if (this.#turns().end(turn.turnId, status, error)) {
      if (status === "completed") this.#emit(context, { type: "finish" });
      this.#turnConfig.delete(turn.turnId);
      const end = await this.#endOf(turn, status, error);
      try {
        await this.#options.hooks?.onTurnEnd?.(end);
      } finally {
        const waiters = this.#waiters.get(turn.turnId);
        this.#waiters.delete(turn.turnId);
        for (const resolve of waiters ?? []) resolve(end);
      }
    }
    return { then: "done", result: { status } };
  }

  // ── Helpers ───────────────────────────────────────────────────────

  async #config(context: ThinkTurnContext): Promise<ThinkTurnConfig> {
    let config = this.#turnConfig.get(context.turnId);
    if (!config) {
      config = (await this.#options.hooks?.beforeTurn?.(context)) ?? {};
      this.#turnConfig.set(context.turnId, config);
    }
    return config;
  }

  async #updateOpenPart(
    chat: string,
    toolCallId: string,
    update: (part: ToolPart) => ToolPart | undefined
  ): Promise<boolean> {
    const turn = this.#turns().running(chat);
    if (!turn) return false;
    const session = this.#session(chat);
    const message = await this.#message(session, turn);
    const part = message ? findToolPart(message, toolCallId) : undefined;
    const next = part ? update(part) : undefined;
    if (!message || !next) return false;
    await session.updateMessage(
      updateToolPart(message, toolCallId, () => next) as SessionMessage
    );
    return true;
  }

  async #message(
    session: Session,
    turn: ThinkTurnRecord
  ): Promise<UIMessage | undefined> {
    const message = await session.getMessage(turn.messageId);
    return (message as unknown as UIMessage | null) ?? undefined;
  }

  async #endOf(
    turn: ThinkTurnRecord,
    status: ThinkTurnStatus,
    error?: string
  ): Promise<ThinkTurnEnd> {
    const current = this.#turns().turn(turn.turnId) ?? turn;
    return {
      ...this.#context(current, undefined),
      status,
      message: await this.#message(this.#session(turn.chat), turn),
      ...(error !== undefined ? { error } : {})
    };
  }

  #context(
    turn: ThinkTurnRecord,
    body: Record<string, unknown> | undefined
  ): ThinkTurnContext {
    return {
      chat: turn.chat,
      turnId: turn.turnId,
      step: turn.step,
      body
    };
  }

  #emit(context: ThinkTurnContext, chunk: UIMessageChunk): void {
    try {
      this.#options.hooks?.onChunk?.({ ...context, chunk });
    } catch (error) {
      this.lifecycle.events.emit("think-harness:error", {
        turnId: context.turnId,
        error: errorText(error)
      });
    }
  }

  #session(chat: string): Session {
    return this.#options.session(chat);
  }

  #turns(): ThinkStore {
    this.#store ??= new ThinkStore(this.lifecycle.storage);
    return this.#store;
  }
}

/** The tools the model sees: everything but what would run them. */
function toModelTools(tools: ToolSet): ToolSet {
  const out: ToolSet = {};
  for (const [name, tool] of Object.entries(tools)) {
    const {
      execute: _execute,
      needsApproval: _needsApproval,
      ...described
    } = tool as Tool;
    out[name] = described as ToolSet[string];
  }
  return out;
}

async function needsApproval(
  tool: ToolSet[string] | undefined,
  call: ThinkToolCall,
  messages: ModelMessage[]
): Promise<boolean> {
  const rule = (tool as Tool | undefined)?.needsApproval;
  if (typeof rule === "function") {
    return Boolean(
      await rule(call.input as never, {
        toolCallId: call.toolCallId,
        messages,
        context: undefined as never
      })
    );
  }
  return rule === true;
}

function settledPart(part: ToolPart, result: ThinkToolResult): ToolPart {
  const {
    errorText: _errorText,
    output: _output,
    ...rest
  } = part as ToolPart & { errorText?: string; output?: unknown };
  return result.ok
    ? { ...rest, state: "output-available", output: result.output }
    : { ...rest, state: "output-error", errorText: result.error };
}

function resultChunk(
  toolCallId: string,
  result: ThinkToolResult
): UIMessageChunk {
  return result.ok
    ? { type: "tool-output-available", toolCallId, output: result.output }
    : { type: "tool-output-error", toolCallId, errorText: result.error };
}

/** Await a tool's output, reporting every value but the last as preliminary. */
async function finalOutput(
  value: unknown,
  preliminary: (output: unknown) => void
): Promise<unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    !(Symbol.asyncIterator in value)
  ) {
    return await value;
  }
  let last: unknown;
  let seen = false;
  for await (const output of value as AsyncIterable<unknown>) {
    if (seen) preliminary(last);
    last = output;
    seen = true;
  }
  return last;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
