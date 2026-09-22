/**
 * The agent loop.
 *
 * This is the `while` loop from , with every effect wrapped in a
 * journaled Tasks step. The shape is the same one you would write by hand:
 *
 *   for each round: call the model; if it asked for tools, run them; repeat.
 *
 * What the capabilities add is that killing the isolate at round 12 does not
 * lose rounds 0-11, does not re-charge a tool that already ran, and does not
 * strand a client watching the output. None of that is visible in the loop
 * body, which is the point.
 */
import { chat, maxIterations, toolDefinition } from "@tanstack/ai";
import type { StreamChunk } from "@tanstack/ai";
import { NonRetryableError } from "agents/tasks";
import type { TaskJson, TaskStep } from "agents/tasks";
import type { StreamWriter } from "agents/streams";
import {
  TextCoalescer,
  assistantMessageId,
  customEvent,
  projectChunk,
  reasoningMessageEndEvent,
  reasoningMessageId,
  runErrorEvent,
  runFinishedEvent,
  runStartedEvent,
  stepFinishedEvent,
  stepStartedEvent,
  textMessageEndEvent,
  toolCallArgsEvent,
  toolCallKey,
  toolResultEvent,
  usageOf
} from "./events";
import type { HarnessRole, TurnEvent } from "./protocol";
import type { ServerTool } from "./tools/types";
import { bound } from "./tools/types";

/** Bytes of recent transcript hydrated per round. Bounds isolate memory. */
export const PROMPT_BYTES = 512 * 1024;
/** Bytes of a tool result shown in its durable event. */
const PREVIEW_BYTES = 512;
const MAX_REASONING_CHARS = 32 * 1024;

/**
 * Retry policy for one model round. A provider hiccup — capacity, a dropped
 * stream — must not fail a turn the user is waiting on, so the step retries
 * on a durable delay and the turn fails only after the budget is spent.
 */
const MODEL_RETRIES = {
  limit: 3,
  delay: "2 seconds",
  backoff: "exponential"
} as const;

/**
 * Retry policy for one tool call. Tighter than the model's: a tool that
 * fails twice is usually wrong rather than unlucky, and the model can often
 * recover better than a retry can by reading the error.
 */
const TOOL_RETRIES = { limit: 2, delay: "1 second" } as const;

export const TURN_DEFINITION = "tiny-harness-turn@v1";

/**
 * A note on mutability in this file.
 *
 * Tasks persists step results and Streams persists chunks, so both boundaries
 * are typed as concrete JSON (`TaskJson`, `StreamJson`) and reject
 * `readonly` arrays and `unknown` fields. That is not pedantry: a value that
 * cannot round-trip through `JSON.stringify` cannot survive a replay, and the
 * compiler is the right place to find that out.
 *
 * So types that cross a durable boundary are declared mutable and
 * JSON-shaped, while types that stay in memory keep `readonly`.
 */

/** Input to one durable turn. Crosses the Tasks boundary. */
export type TurnInput = {
  turnId: string;
  /** AG-UI thread identity. Optional only for pre-projection retained runs. */
  threadId?: string;
  role: HarnessRole;
  userMessageId: string;
};

/** Result of one durable turn. Journaled by Tasks. */
export type TurnResult = {
  turnId: string;
  responseMessageId: string;
  rounds: number;
};

/** One tool call the model asked for. Journaled inside a RoundOutcome. */
export type PendingCall = {
  /** Provider-supplied id, retained only for diagnostics. */
  callId: string;
  /** Harness identity, unique when providers reuse ids across rounds. */
  callKey: string;
  round: number;
  name: string;
  /** Parsed tool arguments. JSON by construction: it came from JSON. */
  input: TaskJson;
};

/** What one model round produced. Journaled, so every field is JSON. */
export type RoundOutcome = {
  text: string;
  calls: PendingCall[];
  inputTokens?: number;
  outputTokens?: number;
};

/**
 * Everything the loop needs from its host. Passing these in rather than
 * reaching for `this` keeps the loop testable and makes the dependency list
 * an explicit, readable contract.
 */
export type TurnDeps = {
  /**
   * Byte-budgeted recent history. The window is a read over
   * durable history, not an array we mutate. The budget bounds hydrated
   * memory; there is deliberately no message-count floor under it, because a
   * floor that admitted rows regardless of size would defeat the bound.
   */
  readonly recentHistory: (
    bytes: number,
    leafId: string
  ) => Promise<{ messages: readonly unknown[] }>;
  /** Current canonical Session leaf for this single-flight turn. */
  readonly latestLeafId: () => Promise<string | null>;
  /** The frozen system prompt for this role. */
  readonly buildSystemPrompt: (role: HarnessRole) => Promise<string>;
  /** The tool set for this role. Tools are constrained per role. */
  readonly tools: (role: HarnessRole) => readonly ServerTool[];
  /** The model adapter for this role. */
  readonly adapter: (role: HarnessRole) => unknown;
  /** Structured diagnostics that never include prompt or tool contents. */
  readonly observe: (
    event: string,
    fields: Record<string, string | number | boolean | undefined>
  ) => void;
  /** Mark the public turn projection as running. */
  readonly start: (turnId: string) => Promise<void>;
  /** Open (or reopen at its cursor) this turn's durable stream. */
  readonly openStream: (turnId: string) => Promise<StreamWriter>;
  /** Persist the assistant's reply. Returns the synchronous commit. */
  readonly commitAssistant: (
    turnId: string,
    round: number,
    outcome: RoundOutcome
  ) => Promise<{ messageId: string; commit: () => void }>;
  /** Persist one tool result to the transcript. Returns its message id. */
  readonly appendToolResult: (
    turnId: string,
    call: PendingCall,
    result: unknown,
    ok: boolean
  ) => Promise<string>;
  /** Run one tool. The harness owns dispatch; the loop owns journaling. */
  readonly runTool: (
    call: PendingCall,
    ctx: {
      turnId: string;
      /** The turn's role, so dispatch resolves the same tool set the model saw. */
      role: HarnessRole;
      idempotencyKey: string;
      signal: AbortSignal;
      interrupted: boolean;
    }
  ) => Promise<unknown>;
  /** Decide whether this call needs a human. */
  readonly needsApproval: (
    call: PendingCall,
    role: HarnessRole
  ) => Promise<boolean>;
  /** Park the turn until a human answers. Resolves to the decision. */
  readonly awaitApproval: (
    call: PendingCall,
    turnId: string,
    step: TaskStep
  ) => Promise<{ approved: boolean; editedArgs?: unknown; note?: string }>;
  /** Update the rebuildable connection cache at a terminal boundary. */
  readonly finish: (turnId: string, status: "completed" | "failed") => void;
  /** Model rounds one turn may take before failing. */
  readonly maxRounds: number;
};

/**
 * Build the Task definition. The host spreads the returned map into
 * `new Tasks({ definitions })`, so the loop is visible in `server.ts` rather
 * than hidden behind a framework registration call.
 */
export function turnDefinitions(deps: TurnDeps) {
  return {
    [TURN_DEFINITION]: async (
      input: TurnInput,
      step: TaskStep
    ): Promise<TurnResult> => {
      try {
        await deps.start(input.turnId);
        return await runTurn(input, step, deps);
      } catch (error) {
        // Tasks ends an execution attempt by *throwing* — a sleep, a retry
        // delay, a cancellation and a superseded attempt all unwind the
        // handler this way. Those are control flow, not failures: the run is
        // still alive and will resume. Settling the turn here would mark
        // every approval wait as failed the moment it parked, so they are
        // rethrown untouched.
        //
        // The signal classes are deliberately not `Error` subclasses and are
        // not exported, so this is a structural check.
        if (isTaskControlFlow(error)) throw error;

        // Tasks records the run failure; settle the client stream too.
        const message = errorMessage(error);
        console.error(
          JSON.stringify({
            component: "tiny-harness",
            event: "turn:failed",
            turnId: input.turnId,
            taskRunId: `harness:${input.turnId}`,
            AGUIRunId: input.turnId,
            error: errorDetails(error)
          })
        );

        try {
          const stream = await deps.openStream(input.turnId);
          stream.append(runErrorEvent(message));
          stream.error(message);
          deps.finish(input.turnId, "failed");
        } catch (streamError) {
          // Do not let stream diagnostics hide the model or tool failure.
          console.error(
            JSON.stringify({
              component: "tiny-harness",
              event: "stream:settlement-failed",
              turnId: input.turnId,
              error: errorDetails(streamError)
            })
          );
          deps.finish(input.turnId, "failed");
        }
        throw error;
      }
    }
  };
}

async function runTurn(
  input: TurnInput,
  step: TaskStep,
  deps: TurnDeps
): Promise<TurnResult> {
  const { turnId, role } = input;
  const threadId = input.threadId ?? turnId;

  // Reopening a live stream returns a writer at its existing cursor. Only a
  // new stream opens the top-level AG-UI run; Task replay keeps one run.
  const stream = await deps.openStream(turnId);
  const emit = (event: TurnEvent) => stream.append(event);
  if (stream.cursor === 0) emit(runStartedEvent(threadId, turnId, role));
  let inputTokens = 0;
  let outputTokens = 0;

  // Frozen once per turn, so every round presents a byte-identical prefix.
  // Built via a journaled step, so replay reuses the exact same string.
  const system = await step.do("prompt", () => deps.buildSystemPrompt(role));

  for (let round = 0; round < deps.maxRounds; round++) {
    await step.status(`Model round ${round + 1}`);

    // The model window is a byte-budgeted read over durable
    // history, not an array we mutate. Compaction has already collapsed old
    // spans; this just bounds what we hydrate into the isolate.
    const leafId = (await deps.latestLeafId()) ?? input.userMessageId;
    const window = await deps.recentHistory(PROMPT_BYTES, leafId);

    const outcome = await step.do(
      `model:${round}`,
      { retries: MODEL_RETRIES, timeout: "2 minutes" },
      async ({ attempt, signal }) => {
        const stepName = `model:${round}:attempt:${attempt}`;
        emit(
          stepStartedEvent(stepName, {
            cloudflare: { kind: "model", round, attempt }
          })
        );
        deps.observe("model:attempt", { turnId, role, round, attempt });
        try {
          const result = await completeRound({
            adapter: deps.adapter(role),
            system,
            turnId,
            round,
            messages: toModelMessages(window.messages),
            tools: deps.tools(role),
            signal,
            attempt,
            emit
          });
          emit(
            stepFinishedEvent(stepName, {
              cloudflare: { status: "completed", round, attempt }
            })
          );
          deps.observe("model:attempt-completed", {
            turnId,
            role,
            round,
            attempt
          });
          return result;
        } catch (error) {
          emit(
            stepFinishedEvent(stepName, {
              cloudflare: {
                status: "failed",
                round,
                attempt,
                error: errorMessage(error)
              }
            })
          );
          deps.observe("model:attempt-failed", {
            turnId,
            role,
            round,
            attempt,
            error: errorMessage(error)
          });
          throw error;
        }
      }
    );

    inputTokens += outcome.inputTokens ?? 0;
    outputTokens += outcome.outputTokens ?? 0;

    // No tool calls means the model is answering, so the turn is over.
    if (outcome.calls.length === 0) {
      const assistant = await deps.commitAssistant(turnId, round, outcome);
      // AG-UI may only report success after the canonical message exists.
      // The message id is deterministic, so replay repairs a crash between
      // this commit and stream settlement without duplicating conversation.
      assistant.commit();
      emit(
        runFinishedEvent(
          threadId,
          turnId,
          {
            responseMessageId: assistant.messageId,
            rounds: round + 1
          },
          { type: "success" },
          [{ inputTokens, outputTokens }]
        )
      );
      stream.close();
      deps.finish(turnId, "completed");
      return {
        turnId,
        responseMessageId: assistant.messageId,
        rounds: round + 1
      };
    }

    // The assistant's tool-call message joins the transcript before the tools
    // run, so a replay sees the same history the model saw.
    //
    // Also outside a step, and safe for the same reason as the tool result
    // below: the message id is `assistant:<turnId>:<round>`, so an `upsert`
    // on replay converges on the one row.
    const assistant = await deps.commitAssistant(turnId, round, outcome);
    assistant.commit();

    for (const call of outcome.calls) {
      // Approval parks the run on a durable deadline. No isolate
      // stays resident while the human decides, so waiting is free.
      if (await deps.needsApproval(call, role)) {
        const decision = await deps.awaitApproval(call, turnId, step);
        emit(
          customEvent("cloudflare.authorization.resolved", {
            approvalId: `${turnId}:${call.callKey}`,
            approved: decision.approved
          })
        );
        if (!decision.approved) {
          const messageId = await deps.appendToolResult(
            turnId,
            call,
            { denied: true, reason: decision.note ?? "denied by user" },
            false
          );
          emit(
            toolResultEvent({
              messageId,
              toolCallId: call.callKey,
              toolName: call.name,
              content: `Denied: ${decision.note ?? "no reason given"}`,
              ok: false
            })
          );
          continue;
        }
        if (decision.editedArgs !== undefined) {
          // A human who edits the arguments has authored a different call.
          // Rebinding here means the journaled step runs the approved input.
          Object.assign(call, { input: decision.editedArgs });
        }
      }

      // Every tool call is one journaled step with a stable idempotency key:
      // identical across attempts and replays, so an external service can
      // dedupe a repeat. `step.interrupted` tells the callback that this
      // exact step died mid-flight last time, so a tool with irreversible
      // effects can look for evidence instead of blindly re-running.
      // Journal keys must be unique within a run *and* stable across
      // replays. `callId` alone is neither enough nor safe: a model may
      // reuse an id across rounds, so the round number goes in the name.
      const stepName = `tool:${call.callKey}`;
      const { value, ok } = await step.do(
        stepName,
        { retries: TOOL_RETRIES, timeout: "5 minutes" },
        async ({ idempotencyKey, signal }) => {
          try {
            const result = await deps.runTool(call, {
              turnId,
              role,
              idempotencyKey,
              signal,
              interrupted: step.interrupted?.name === stepName
            });
            return { value: result as never, ok: true };
          } catch (error) {
            // A tool that throws is information for the model, not a turn
            // failure: it reads the error and tries something else. Only
            // returning it lets the journal record the attempt as settled.
            return {
              value: { error: errorMessage(error) } as never,
              ok: false
            };
          }
        }
      );

      // This write is outside the step that produced `value`, so a crash in
      // between leaves the journal holding a result the transcript has not
      // got. That is safe here, and only because of the id: the row is keyed
      // `tool:<turnId>:<callId>`, so the replay that re-runs this line lands
      // on the same row rather than adding a second one. Keep the key
      // deterministic and this stays benign; make it a UUID and it becomes a
      // duplicated tool result on every replay.
      const messageId = await deps.appendToolResult(turnId, call, value, ok);
      emit(
        toolResultEvent({
          messageId,
          toolCallId: call.callKey,
          toolName: call.name,
          content: bound(stringify(value), PREVIEW_BYTES),
          ok
        })
      );
    }
  }

  // Exhausting the round budget is a real failure and retrying the whole turn
  // would just spend it again, so it is explicitly non-retryable.
  throw new NonRetryableError(
    `Turn ${turnId} exceeded ${deps.maxRounds} model rounds without finishing`
  );
}

/**
 * One model round: stream the reply, project chunks onto the durable log, and
 * collect the tool calls the model asked for.
 *
 * `maxIterations(1)` is deliberate and load-bearing. TanStack's own agent
 * loop would happily run the tools itself and iterate, but then a crash
 * mid-iteration would be invisible to Tasks and unjournaled. We take exactly
 * one model turn per step and own the iteration ourselves, which is what
 * makes every round individually replayable.
 */
async function completeRound(args: {
  adapter: unknown;
  system: string;
  turnId: string;
  round: number;
  /** Already converted to TanStack model messages by the boundary adapter. */
  messages: readonly ModelInputMessage[];
  tools: readonly ServerTool[];
  signal: AbortSignal;
  attempt: number;
  emit: (event: TurnEvent) => void;
}): Promise<RoundOutcome> {
  const abort = new AbortController();
  const onAbort = () => abort.abort();
  args.signal.addEventListener("abort", onAbort, { once: true });

  const calls = new Map<string, { name: string; args: string }>();
  let text = "";
  let usage: { inputTokens?: number; outputTokens?: number } = {};

  // Coalesce content deltas while retaining their AG-UI message identity.
  const projection = {
    turnId: args.turnId,
    round: args.round,
    attempt: args.attempt
  };
  const coalescer = new TextCoalescer(
    args.emit,
    assistantMessageId(args.turnId, args.round, args.attempt)
  );
  const reasoning = new TextCoalescer(
    args.emit,
    reasoningMessageId(args.turnId, args.round, args.attempt),
    2048,
    "reasoning"
  );
  let reasoningChars = 0;
  let reasoningTruncated = false;
  let textOpen = false;
  let reasoningOpen = false;

  try {
    const stream = chat({
      adapter: args.adapter as never,
      messages: args.messages as never,
      systemPrompts: [args.system],
      // TanStack sees declarations only; the durable loop executes tools.
      tools: args.tools.map((tool) =>
        toolDefinition({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema as never,
          ...(tool.needsApproval ? { needsApproval: true as const } : {})
        })
      ) as never,
      agentLoopStrategy: maxIterations(1),
      modelOptions: {
        max_tokens: 4096,
        reasoning_effort: args.attempt === 1 ? "low" : null,
        chat_template_kwargs: {
          enable_thinking: args.attempt === 1
        }
      } as never,
      abortController: abort
    });

    for await (const chunk of stream as AsyncIterable<StreamChunk>) {
      switch (chunk.type) {
        case "TEXT_MESSAGE_START":
          textOpen = true;
          args.emit(projectChunk(chunk, projection)!);
          break;
        case "TEXT_MESSAGE_CONTENT":
          if (chunk.delta) {
            text += chunk.delta;
            coalescer.push(chunk.delta);
          }
          break;
        case "TEXT_MESSAGE_END":
          coalescer.flush();
          args.emit(projectChunk(chunk, projection)!);
          textOpen = false;
          break;

        case "REASONING_MESSAGE_START":
          reasoningOpen = true;
          args.emit(projectChunk(chunk, projection)!);
          break;
        case "REASONING_MESSAGE_CONTENT": {
          if (!chunk.delta) break;
          const remaining = Math.max(0, MAX_REASONING_CHARS - reasoningChars);
          const admitted = chunk.delta.slice(0, remaining);
          if (admitted) reasoning.push(admitted);
          reasoningChars += admitted.length;
          if (admitted.length < chunk.delta.length && !reasoningTruncated) {
            reasoningTruncated = true;
            args.emit(
              customEvent("cloudflare.reasoning.truncated", {
                maxCharacters: MAX_REASONING_CHARS
              })
            );
          }
          break;
        }
        case "REASONING_MESSAGE_END":
          reasoning.flush();
          args.emit(projectChunk(chunk, projection)!);
          reasoningOpen = false;
          break;

        case "TOOL_CALL_START":
          coalescer.flush();
          reasoning.flush();
          calls.set(chunk.toolCallId, {
            name: chunk.toolCallName ?? chunk.toolName ?? "unknown",
            args: ""
          });
          args.emit(projectChunk(chunk, projection)!);
          break;

        case "TOOL_CALL_ARGS": {
          const entry = calls.get(chunk.toolCallId);
          if (entry && chunk.delta) entry.args += chunk.delta;
          args.emit(projectChunk(chunk, projection)!);
          break;
        }

        case "TOOL_CALL_END": {
          const entry = calls.get(chunk.toolCallId);
          if (entry && chunk.input !== undefined && entry.args.length === 0) {
            entry.args = JSON.stringify(chunk.input);
            args.emit(
              toolCallArgsEvent(
                toolCallKey(args.round, chunk.toolCallId),
                entry.args
              )
            );
          }
          args.emit(projectChunk(chunk, projection)!);
          break;
        }

        case "RUN_FINISHED":
        case "RUN_ERROR": {
          coalescer.flush();
          reasoning.flush();
          usage = usageOf(chunk) ?? {};
          if (chunk.type === "RUN_ERROR") {
            const message =
              chunk.error?.message ?? chunk.message ?? "model run failed";
            // A provider attempt is a step failure, not an AG-UI run failure.
            throw new Error(message);
          }
          break;
        }
      }
    }
  } finally {
    coalescer.flush();
    reasoning.flush();
    if (textOpen) {
      args.emit(
        textMessageEndEvent(
          assistantMessageId(args.turnId, args.round, args.attempt)
        )
      );
    }
    if (reasoningOpen) {
      args.emit(
        reasoningMessageEndEvent(
          reasoningMessageId(args.turnId, args.round, args.attempt)
        )
      );
    }
    args.signal.removeEventListener("abort", onAbort);
  }

  return {
    text,
    calls: [...calls.entries()].map(([callId, entry]) => ({
      callId,
      callKey: toolCallKey(args.round, callId),
      round: args.round,
      name: entry.name,
      input: parseArgs(entry.args)
    })),
    ...usage
  };
}

/**
 * Parse streamed tool arguments.
 *
 * The return type is `TaskJson` rather than `unknown` because the parsed
 * value is journaled: it came from JSON text, so it is JSON by construction,
 * and saying so lets the whole `RoundOutcome` cross the Tasks boundary
 * without a cast.
 */
/**
 * Convert Sessions messages into TanStack AI model messages.
 *
 * Sessions stores neutral message parts; TanStack's `chat()` wants
 * `{ role, content }` plus provider-style tool relationships. This boundary
 * adapter preserves native call IDs, arguments, results, and errors without
 * putting TanStack types into the Session records.
 */
type ModelInputMessage = {
  role: "user" | "assistant" | "tool";
  content: string;
  toolCalls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
  toolCallId?: string;
  error?: string;
};

function toModelMessages(messages: readonly unknown[]): ModelInputMessage[] {
  const out: ModelInputMessage[] = [];

  for (const raw of messages) {
    if (typeof raw !== "object" || raw === null) continue;
    const message = raw as {
      role?: string;
      content?: unknown;
      parts?: readonly unknown[];
    };

    // Already a model message.
    if (typeof message.content === "string" && message.content.length > 0) {
      out.push({
        role: message.role === "assistant" ? "assistant" : "user",
        content: message.content
      });
      continue;
    }

    const fragments: string[] = [];
    const calls: NonNullable<ModelInputMessage["toolCalls"]> = [];
    let toolResult:
      | { toolCallId: string; content: string; error?: string }
      | undefined;
    for (const part of message.parts ?? []) {
      if (typeof part !== "object" || part === null) continue;
      const typed = part as {
        type?: string;
        text?: string;
        state?: string;
        toolCallId?: string;
        toolName?: string;
        input?: unknown;
        output?: unknown;
        errorText?: string;
      };

      if (typed.type === "text" && typed.text) {
        fragments.push(typed.text);
        continue;
      }
      if (
        typed.type === "tool-call" &&
        typeof typed.toolCallId === "string" &&
        typeof typed.toolName === "string"
      ) {
        calls.push({
          id: typed.toolCallId,
          type: "function",
          function: {
            name: typed.toolName,
            arguments: safeJson(typed.input)
          }
        });
      }
      if (
        typed.type === "tool-result" &&
        typeof typed.toolCallId === "string"
      ) {
        toolResult = {
          toolCallId: typed.toolCallId,
          content: safeJson(typed.output),
          ...(typed.errorText ? { error: typed.errorText } : {})
        };
      }
    }

    const content = fragments.join("\n").trim();
    if (message.role === "tool" && toolResult) {
      out.push({
        role: "tool",
        content: toolResult.content,
        toolCallId: toolResult.toolCallId,
        ...(toolResult.error ? { error: toolResult.error } : {})
      });
      continue;
    }
    if (content.length === 0 && calls.length === 0) continue;
    out.push({
      role: message.role === "assistant" ? "assistant" : "user",
      content,
      ...(calls.length > 0 ? { toolCalls: calls } : {})
    });
  }

  return out;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function parseArgs(raw: string): TaskJson {
  if (raw.trim().length === 0) return {};
  try {
    return JSON.parse(raw) as TaskJson;
  } catch {
    // A model that emits malformed JSON should hear about it from the tool
    // layer, not crash the round. The schema check will reject it and the
    // model gets a validation error it can act on.
    return { __malformed: raw };
  }
}

function stringify(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/**
 * True when a thrown value is one of Tasks' control-flow signals.
 *
 * `TaskSuspension` (a sleep or a retry delay), `TaskCancellation` and
 * `AttemptSupersededError` all end an execution attempt without failing the
 * run. The first two are intentionally not `Error` subclasses — the library's
 * own comment says this is so a `catch` around unrelated work is less likely
 * to swallow them — and none of the three type guards are exported, so they
 * are recognised structurally here.
 *
 * Getting this wrong is not subtle: treating a sleep as a failure settles
 * every parked turn the instant it parks, which breaks human approval
 * entirely.
 */
function isTaskControlFlow(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const signal = value as {
    reason?: unknown;
    wakeAt?: unknown;
    name?: unknown;
  };
  // TaskSuspension: { wakeAt, reason: "sleep" | "retry" }
  if (typeof signal.wakeAt === "number") return true;
  // TaskCancellation: { reason }, and AttemptSupersededError by name.
  if (signal.name === "AttemptSupersededError") return true;
  return (
    value.constructor?.name === "TaskCancellation" ||
    value.constructor?.name === "TaskSuspension"
  );
}

/**
 * A readable message for anything that was thrown.
 *
 * `String(error)` yields "[object Object]" for a plain object, which is what
 * several libraries reject with — and an error message of "[object Object]"
 * in a failed Task snapshot is indistinguishable from no diagnosis at all.
 * So fall back to a `message` property, then to JSON.
 */
function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (typeof error === "object" && error !== null) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message.length > 0) return message;
    try {
      return JSON.stringify(error) ?? "unknown error";
    } catch {
      return "unknown error";
    }
  }
  return String(error);
}

/** Preserve non-enumerable Error fields and nested causes in Worker logs. */
function errorDetails(
  error: unknown,
  seen: WeakSet<object> = new WeakSet(),
  depth = 0
): unknown {
  if (typeof error !== "object" || error === null) return error;
  if (depth >= 6) return "[maximum error depth reached]";
  if (seen.has(error)) return "[circular error reference]";
  seen.add(error);

  const details: Record<string, unknown> = {};
  for (const key of Object.getOwnPropertyNames(error)) {
    let value: unknown;
    try {
      value = (error as Record<string, unknown>)[key];
    } catch {
      value = "[unreadable property]";
    }
    details[key] = errorDetails(value, seen, depth + 1);
  }

  if (error instanceof Error) {
    details.name = error.name;
    details.message = error.message;
    details.stack = error.stack;
  }
  return details;
}
