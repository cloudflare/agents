import type { ChatStartEvent, StreamCallback } from "@cloudflare/think";
import { RpcTarget } from "cloudflare:workers";

type Wake = () => void;

export interface TextStreamCallbackOptions {
  visibleSoftLimit?: number;
}

export class TextStreamCallback extends RpcTarget implements StreamCallback {
  private readonly visibleChunks: string[] = [];
  private readonly wakeups: Wake[] = [];
  private readonly visibleSoftLimit?: number;
  private text = "";
  private visibleTextValue = "";
  private chatRequestId?: string;
  private closed = false;
  private visibleClosed = false;
  private visibleLimitReachedValue = false;
  private error?: Error;

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

  textSoFar(): string {
    return this.text;
  }

  visibleText(): string {
    return this.visibleTextValue;
  }

  remainingText(): string {
    return this.text.slice(this.visibleTextValue.length);
  }

  visibleLimitReached(): boolean {
    return this.visibleLimitReachedValue;
  }

  requestId(): string | undefined {
    return this.chatRequestId;
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

  private wake(): void {
    for (const wake of this.wakeups.splice(0)) {
      wake();
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
}

export function textDeltaFromStreamChunk(json: string): string | null {
  try {
    const chunk = JSON.parse(json) as { type?: string; delta?: unknown };
    return chunk.type === "text-delta" && typeof chunk.delta === "string"
      ? chunk.delta
      : null;
  } catch {
    return null;
  }
}
