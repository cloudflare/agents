import { RpcTarget } from "cloudflare:workers";
import type { FiberContext } from "agents";
import type { UIMessage } from "ai";
import type { ChatStartEvent, StreamCallback } from "../think";
import type { MessengerEvent } from "./events";
import { toMessengerUserMessage } from "./events";

export const MESSENGER_REPLY_FIBER_NAME = "think:messenger-reply";

export const EMPTY_MESSENGER_RESPONSE =
  "I couldn't produce a text response. Please try again.";
export const ERROR_MESSENGER_RESPONSE =
  "Sorry, I couldn't answer that right now. Please try again.";
export const INTERRUPTED_MESSENGER_RESPONSE =
  "Sorry, my reply was interrupted. Please send your message again if you'd like me to retry.";

type Wake = () => void;

export interface TextStreamCallbackOptions {
  visibleSoftLimit?: number;
}

export class TextStreamCallback extends RpcTarget implements StreamCallback {
  private readonly visibleChunks: string[] = [];
  private readonly wakeups: Wake[] = [];
  private readonly visibleSoftLimit?: number;
  private chatRequestId?: string;
  private closed = false;
  private error?: Error;
  private text = "";
  private visibleClosed = false;
  private visibleLimitReachedValue = false;
  private visibleTextValue = "";

  constructor(options: TextStreamCallbackOptions = {}) {
    super();
    this.visibleSoftLimit = options.visibleSoftLimit;
  }

  onStart(event: ChatStartEvent): void {
    this.chatRequestId = event.requestId;
  }

  onEvent(json: string): void {
    const text = textDeltaFromStreamChunk(json);
    if (!text) {
      return;
    }

    this.text += text;
    this.pushVisibleText(text);
    this.wake();
  }

  onDone(): void {
    this.close();
  }

  onError(error: string): void {
    this.fail(new Error(error));
  }

  close(): void {
    this.closed = true;
    this.visibleClosed = true;
    this.wake();
  }

  fail(error: unknown): void {
    this.error = error instanceof Error ? error : new Error(String(error));
    this.closed = true;
    this.visibleClosed = true;
    this.wake();
  }

  hasText(): boolean {
    return this.text.trim().length > 0;
  }

  remainingText(): string {
    return this.text.slice(this.visibleTextValue.length);
  }

  requestId(): string | undefined {
    return this.chatRequestId;
  }

  textSoFar(): string {
    return this.text;
  }

  visibleLimitReached(): boolean {
    return this.visibleLimitReachedValue;
  }

  visibleText(): string {
    return this.visibleTextValue;
  }

  async *stream(): AsyncIterable<string> {
    while (true) {
      const next = this.visibleChunks.shift();
      if (next !== undefined) {
        yield next;
        continue;
      }

      if (this.error) {
        throw this.error;
      }

      if (this.closed || this.visibleClosed) {
        return;
      }

      await new Promise<void>((resolve) => {
        this.wakeups.push(resolve);
      });
    }
  }

  private pushVisibleText(text: string): void {
    if (this.visibleClosed) {
      return;
    }

    if (this.visibleSoftLimit === undefined) {
      this.visibleChunks.push(text);
      this.visibleTextValue += text;
      return;
    }

    const remaining = this.visibleSoftLimit - this.visibleTextValue.length;
    if (remaining <= 0) {
      this.visibleClosed = true;
      this.visibleLimitReachedValue = true;
      return;
    }

    const visible = text.slice(0, remaining);
    if (visible) {
      this.visibleChunks.push(visible);
      this.visibleTextValue += visible;
    }

    if (
      visible.length < text.length ||
      this.visibleTextValue.length >= this.visibleSoftLimit
    ) {
      this.visibleClosed = true;
      this.visibleLimitReachedValue = true;
    }
  }

  private wake(): void {
    for (const wake of this.wakeups.splice(0)) {
      wake();
    }
  }
}

export function textDeltaFromStreamChunk(json: string): string | null {
  try {
    const chunk = JSON.parse(json) as { delta?: unknown; type?: string };
    return chunk.type === "text-delta" && typeof chunk.delta === "string"
      ? chunk.delta
      : null;
  } catch {
    return null;
  }
}

export type MessengerReplyStage = "accepted" | "streaming" | "completed";

export interface MessengerReplySnapshot {
  event: MessengerEvent;
  stage: MessengerReplyStage;
  thread?: unknown;
  type: typeof MESSENGER_REPLY_FIBER_NAME;
}

export function messengerReplySnapshot(
  stage: MessengerReplyStage,
  event: MessengerEvent,
  thread?: unknown
): MessengerReplySnapshot {
  return {
    event,
    stage,
    thread,
    type: MESSENGER_REPLY_FIBER_NAME
  };
}

export function parseMessengerReplySnapshot(
  snapshot: unknown
): MessengerReplySnapshot | null {
  if (snapshot === null || typeof snapshot !== "object") {
    return null;
  }

  const candidate = snapshot as Partial<MessengerReplySnapshot>;
  if (
    candidate.type !== MESSENGER_REPLY_FIBER_NAME ||
    (candidate.stage !== "accepted" &&
      candidate.stage !== "streaming" &&
      candidate.stage !== "completed") ||
    candidate.event === undefined
  ) {
    return null;
  }

  return {
    event: candidate.event,
    stage: candidate.stage,
    thread: candidate.thread,
    type: MESSENGER_REPLY_FIBER_NAME
  };
}

export function messengerReplyRecoveryMode(
  snapshot: MessengerReplySnapshot
): "answer" | "apologize" | null {
  if (snapshot.stage === "accepted") {
    return "answer";
  }
  if (snapshot.stage === "streaming") {
    return "apologize";
  }
  return null;
}

export function messengerReplyFailureMode(
  hasStreamedText: boolean,
  completedModelTurn = false,
  expectedDeliveryCompletion = false
): "apologize" | "error" | null {
  if (expectedDeliveryCompletion) {
    return null;
  }

  if (completedModelTurn) {
    return "error";
  }

  return hasStreamedText ? "apologize" : "error";
}

export interface MessengerDeliveryTarget {
  cancelChat(requestId: string, reason?: string): Promise<boolean>;
  chat(
    userMessage: string | UIMessage,
    callback: StreamCallback
  ): Promise<void>;
  chatWithMessengerContext?(
    userMessage: string | UIMessage,
    callback: StreamCallback,
    context: MessengerEvent
  ): Promise<void>;
}

export interface MessengerDeliverySurface {
  post(
    message: string | { markdown: string } | AsyncIterable<string>
  ): Promise<unknown>;
  startTyping?(status?: string): Promise<void>;
}

export interface MessengerDeliveryPolicy {
  emptyResponseText?: string;
  errorResponseText?: string;
  interruptedResponseText?: string;
  isExpectedDeliveryCompletion?(
    error: unknown,
    callback: TextStreamCallback
  ): boolean;
  splitText?(text: string): string[];
  visibleSoftLimit?: number;
}

export interface DeliverMessengerReplyOptions {
  event: MessengerEvent;
  fiber?: FiberContext;
  policy?: MessengerDeliveryPolicy;
  snapshotEvent?: MessengerEvent;
  snapshotThread?: unknown;
  surface: MessengerDeliverySurface;
  target: MessengerDeliveryTarget;
  userMessage?: UIMessage;
}

export async function deliverMessengerReply(
  options: DeliverMessengerReplyOptions
): Promise<void> {
  const callback = new TextStreamCallback({
    visibleSoftLimit: options.policy?.visibleSoftLimit
  });
  const emptyResponseText =
    options.policy?.emptyResponseText ?? EMPTY_MESSENGER_RESPONSE;
  const errorResponseText =
    options.policy?.errorResponseText ?? ERROR_MESSENGER_RESPONSE;
  const interruptedResponseText =
    options.policy?.interruptedResponseText ?? INTERRUPTED_MESSENGER_RESPONSE;
  let completedModelTurn = false;
  const snapshotEvent = options.snapshotEvent ?? options.event;

  options.fiber?.stash(
    messengerReplySnapshot("streaming", snapshotEvent, options.snapshotThread)
  );
  const post = options.surface
    .post(callback.stream())
    .catch(async (error: unknown) => {
      if (options.policy?.isExpectedDeliveryCompletion?.(error, callback)) {
        return;
      }

      const requestId = callback.requestId();
      if (requestId) {
        await options.target
          .cancelChat(requestId, toError(error).message)
          .catch(() => undefined);
      }
      callback.fail(error);
      throw error;
    });

  try {
    await options.surface.startTyping?.("Thinking...");
    const userMessage =
      options.userMessage ?? toMessengerUserMessage(options.event);
    if (options.target.chatWithMessengerContext) {
      await options.target.chatWithMessengerContext(
        userMessage,
        callback,
        snapshotEvent
      );
    } else {
      await options.target.chat(userMessage, callback);
    }
    completedModelTurn = true;
    callback.close();
    await post;
    if (!callback.hasText()) {
      await options.surface.post(emptyResponseText);
    }
    for (const chunk of options.policy?.splitText?.(callback.remainingText()) ??
      []) {
      await options.surface.post(chunk);
    }
    options.fiber?.stash(
      messengerReplySnapshot("completed", snapshotEvent, options.snapshotThread)
    );
  } catch (error) {
    callback.fail(error);
    await post.catch(() => undefined);
    const failureMode = messengerReplyFailureMode(
      callback.hasText(),
      completedModelTurn,
      options.policy?.isExpectedDeliveryCompletion?.(error, callback)
    );

    if (failureMode === null) {
      options.fiber?.stash(
        messengerReplySnapshot(
          "completed",
          snapshotEvent,
          options.snapshotThread
        )
      );
      return;
    }

    if (failureMode === "apologize") {
      await options.surface
        .post(interruptedResponseText)
        .catch(() => undefined);
      options.fiber?.stash(
        messengerReplySnapshot(
          "completed",
          snapshotEvent,
          options.snapshotThread
        )
      );
      return;
    }

    await options.surface
      .post({
        markdown: errorResponseText
      })
      .catch(() => undefined);
    options.fiber?.stash(
      messengerReplySnapshot("completed", snapshotEvent, options.snapshotThread)
    );
  }
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
