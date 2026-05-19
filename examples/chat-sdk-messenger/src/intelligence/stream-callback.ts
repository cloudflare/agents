import type { ChatStartEvent, StreamCallback } from "@cloudflare/think";
import { RpcTarget } from "cloudflare:workers";

type Wake = () => void;

export class TextStreamCallback extends RpcTarget implements StreamCallback {
  private readonly chunks: string[] = [];
  private readonly wakeups: Wake[] = [];
  private text = "";
  private chatRequestId?: string;
  private closed = false;
  private error?: Error;

  onStart(event: ChatStartEvent): void {
    this.chatRequestId = event.requestId;
  }

  onEvent(json: string): void {
    const text = textDeltaFromStreamChunk(json);
    if (!text) {
      return;
    }

    this.chunks.push(text);
    this.text += text;
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
    this.wake();
  }

  fail(error: unknown): void {
    this.error = error instanceof Error ? error : new Error(String(error));
    this.closed = true;
    this.wake();
  }

  hasText(): boolean {
    return this.text.trim().length > 0;
  }

  textSoFar(): string {
    return this.text;
  }

  requestId(): string | undefined {
    return this.chatRequestId;
  }

  async *stream(): AsyncIterable<string> {
    while (true) {
      const next = this.chunks.shift();
      if (next !== undefined) {
        yield next;
        continue;
      }

      if (this.error) {
        throw this.error;
      }

      if (this.closed) {
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
