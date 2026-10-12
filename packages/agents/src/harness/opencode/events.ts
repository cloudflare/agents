import { operationIdOf } from "./operation-id";
import type {
  OpenCodeEvent,
  OpenCodeMessage,
  OpenCodeOperationResult,
  OpenCodeSessionEvent,
  OpenCodeSessionId,
  OpenCodeSessionSnapshot
} from "./types";

type ToolContent = readonly (
  | { readonly type: "text"; readonly text: string }
  | { readonly type: string }
)[];

/** The text parts of a tool's result, joined. */
function toolText(content: ToolContent | undefined): string {
  return (content ?? [])
    .map((part) => ("text" in part ? part.text : ""))
    .join("\n");
}

/** The session an OpenCode event belongs to, if it belongs to one. */
export function sessionIdOf(event: {
  readonly data?: unknown;
}): string | undefined {
  const data: unknown = event.data;
  return typeof data === "object" &&
    data !== null &&
    "sessionID" in data &&
    typeof data.sessionID === "string"
    ? data.sessionID
    : undefined;
}

/** The newest assistant message: what an operation's result is read from. */
type Answer = {
  readonly id: string;
  /** Text parts by ordinal. */
  readonly text: Map<number, string>;
  error: string | undefined;
};

function answerOf(message: OpenCodeMessage): Answer | undefined {
  if (message.type !== "assistant") return undefined;
  const text = new Map<number, string>();
  for (const part of message.content) {
    if (part.type === "text") text.set(text.size, part.text);
  }
  return { id: message.id, text, error: message.error?.message };
}

/**
 * Translates one session's OpenCode events into `OpenCodeSessionEvent`s.
 *
 * OpenCode's events leave out some of what the translated ones carry, so
 * the projector keeps it: tool names (`session.tool.called` has only the
 * call id), and which inputs the current answer is for, so it can report
 * `operation_end`. It starts from the stream's snapshot, so a stream opened
 * mid-run knows the run's inputs and tools.
 *
 * `operation_end` follows the rule `wait()` uses on the transcript: an
 * input's answer ends at the next input that joins after an assistant
 * message, or at the end of the run.
 *
 * Events that arrive while the snapshot is read are projected after it, so
 * some repeat what the snapshot shows. Projection is idempotent for those:
 * an input the projector already knows is not started or ended again.
 */
export class SessionEventProjector {
  readonly #session: OpenCodeSessionId;
  readonly #toolNames = new Map<string, string>();
  /** Inputs the next or current assistant message answers, oldest first. */
  #answering: string[] = [];
  /** Inputs this stream has reported `operation_end` for. */
  readonly #ended = new Set<string>();
  /** Whether an assistant message started after the newest input. */
  #answered = false;
  #answer: Answer | undefined;

  constructor(snapshot: OpenCodeSessionSnapshot) {
    this.#session = snapshot.session;
    for (const message of snapshot.messages) {
      if (message.type !== "assistant") continue;
      for (const part of message.content) {
        if (part.type === "tool") this.#toolNames.set(part.id, part.name);
      }
    }
    this.#answering = snapshot.pending
      .filter((operation) => operation.status === "running")
      .map((operation) => operation.operationId);
    if (this.#answering.length > 0) {
      const last = snapshot.messages.at(-1);
      this.#answer = last === undefined ? undefined : answerOf(last);
      this.#answered = this.#answer !== undefined;
    }
  }

  /** The translated events for one OpenCode event; often none. */
  project(event: OpenCodeEvent): OpenCodeSessionEvent[] {
    switch (event.type) {
      case "session.inbox.enqueued":
        return event.data.item.type === "user"
          ? [
              {
                type: "operation_queued",
                operationId: operationIdOf(event.data.inboxID)
              }
            ]
          : [];
      case "session.inbox.cancelled":
        return [
          {
            type: "operation_withdrawn",
            operationId: operationIdOf(event.data.inboxID)
          }
        ];
      case "session.inbox.delivered": {
        const operationId = operationIdOf(event.data.inboxID);
        // Already in the snapshot, or already answered: a repeat.
        if (
          this.#answering.includes(operationId) ||
          this.#ended.has(operationId)
        ) {
          return [];
        }
        const ended = this.#answered ? this.#settle("succeeded") : [];
        this.#answering.push(operationId);
        return [...ended, { type: "operation_start", operationId }];
      }
      case "session.execution.started":
        // Nothing from an earlier run answers this one's inputs.
        if (this.#answering.length === 0) {
          this.#answer = undefined;
          this.#answered = false;
        }
        return [{ type: "run_start" }];
      case "session.execution.succeeded":
        return [...this.#settle("succeeded"), runEnd("succeeded")];
      case "session.execution.failed":
        return [
          ...this.#settle("failed", event.data.error.message),
          runEnd("failed", event.data.error.message)
        ];
      case "session.execution.interrupted":
        return [...this.#settle("interrupted"), runEnd("interrupted")];
      case "session.step.started":
        this.#answered = true;
        this.#answer = {
          id: event.data.assistantMessageID,
          text: new Map(),
          error: undefined
        };
        return [
          {
            type: "message_start",
            messageId: event.data.assistantMessageID,
            agent: event.data.agent,
            model: {
              providerID: event.data.model.providerID,
              id: event.data.model.id
            }
          }
        ];
      case "session.step.ended":
        return [
          {
            type: "message_end",
            messageId: event.data.assistantMessageID,
            finish: event.data.finish
          }
        ];
      case "session.step.failed":
        if (this.#answer?.id === event.data.assistantMessageID) {
          this.#answer.error = event.data.error.message;
        }
        return [
          {
            type: "message_end",
            messageId: event.data.assistantMessageID,
            finish: "error",
            error: event.data.error.message
          }
        ];
      case "session.text.delta":
      case "session.reasoning.delta":
        return [
          {
            type:
              event.type === "session.text.delta"
                ? "text_delta"
                : "reasoning_delta",
            messageId: event.data.assistantMessageID,
            ordinal: event.data.ordinal,
            delta: event.data.delta
          }
        ];
      case "session.text.ended":
        if (this.#answer?.id === event.data.assistantMessageID) {
          this.#answer.text.set(event.data.ordinal, event.data.text);
        }
        return [
          {
            type: "text_end",
            messageId: event.data.assistantMessageID,
            ordinal: event.data.ordinal,
            text: event.data.text
          }
        ];
      case "session.reasoning.ended":
        return [
          {
            type: "reasoning_end",
            messageId: event.data.assistantMessageID,
            ordinal: event.data.ordinal,
            text: event.data.text
          }
        ];
      case "session.tool.input.started":
        this.#toolNames.set(event.data.id, event.data.name);
        return [];
      case "session.tool.called":
        return [
          {
            type: "tool_start",
            messageId: event.data.assistantMessageID,
            toolCallId: event.data.id,
            name: this.#toolNames.get(event.data.id) ?? "",
            input: event.data.input
          }
        ];
      case "session.tool.success":
        return [
          {
            type: "tool_end",
            messageId: event.data.assistantMessageID,
            toolCallId: event.data.id,
            name: this.#toolNames.get(event.data.id) ?? "",
            error: false,
            output: toolText(event.data.content)
          }
        ];
      case "session.tool.failed":
        return [
          {
            type: "tool_end",
            messageId: event.data.assistantMessageID,
            toolCallId: event.data.id,
            name: this.#toolNames.get(event.data.id) ?? "",
            error: true,
            output: event.data.error.message
          }
        ];
      case "session.retry.scheduled":
        return [
          {
            type: "retry_scheduled",
            messageId: event.data.assistantMessageID,
            attempt: event.data.attempt,
            at: event.data.at,
            error: event.data.error.message
          }
        ];
      case "session.compaction.started":
        return [{ type: "compaction_start", reason: event.data.reason }];
      case "session.compaction.ended":
        return [{ type: "transcript_reset", reason: "compaction" }];
      case "session.compaction.failed":
        return [
          {
            type: "fault",
            code: "compaction_failed",
            message: event.data.error.message
          }
        ];
      case "permission.asked":
        return [
          {
            type: "permission_asked",
            permission: {
              id: event.data.id,
              session: event.data.sessionID,
              action: event.data.action,
              resources: event.data.resources,
              ...(event.data.message === undefined
                ? {}
                : { message: event.data.message })
            }
          }
        ];
      case "permission.replied":
        return [
          {
            type: "permission_replied",
            permissionId: event.data.requestID,
            reply: event.data.reply
          }
        ];
      default:
        return [];
    }
  }

  /** End every input the latest answer was for. */
  #settle(
    outcome: "succeeded" | "failed" | "interrupted",
    runError?: string
  ): OpenCodeSessionEvent[] {
    const answer = this.#answer;
    const text = [...(answer?.text ?? new Map<number, string>()).entries()]
      .sort(([a], [b]) => a - b)
      .map(([, part]) => part)
      .join("");
    const error = answer?.error ?? runError;
    const ended = this.#answering.map((operationId): OpenCodeSessionEvent => {
      this.#ended.add(operationId);
      return {
        type: "operation_end",
        result: resultOf(this.#session, operationId, outcome, text, error)
      };
    });
    this.#answering = [];
    this.#answered = false;
    this.#answer = undefined;
    return ended;
  }
}

function runEnd(
  outcome: "succeeded" | "failed" | "interrupted",
  error?: string
): OpenCodeSessionEvent {
  return {
    type: "run_end",
    outcome,
    ...(error === undefined ? {} : { error })
  };
}

/** The result `wait()` would return for the same ending. */
function resultOf(
  session: OpenCodeSessionId,
  operationId: string,
  outcome: "succeeded" | "failed" | "interrupted",
  text: string,
  error: string | undefined
): OpenCodeOperationResult {
  if (outcome === "succeeded" && error === undefined) {
    return { operationId, session, status: "done", text };
  }
  return {
    operationId,
    session,
    status: "unanswered",
    reason: outcome === "interrupted" ? "interrupted" : (error ?? "failed")
  };
}
