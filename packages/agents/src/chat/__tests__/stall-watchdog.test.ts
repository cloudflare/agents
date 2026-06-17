import { describe, expect, it } from "vitest";
import {
  ChatStreamStalledError,
  iterateWithStallWatchdog
} from "../stall-watchdog";

/**
 * Layer-2 unit tests for the shared stall watchdog (rfc-chat-recovery-foundation,
 * Phase 3 slice 3a). Extracted verbatim from `@cloudflare/think`'s
 * `_iterateWithStallWatchdog`; both `@cloudflare/think` and (slice 3b)
 * `@cloudflare/ai-chat` consume it to route a hung stream into bounded recovery.
 */

async function* fromArray<T>(items: T[]): AsyncGenerator<T> {
  for (const item of items) {
    yield item;
  }
}

async function collect<T>(source: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of source) out.push(item);
  return out;
}

describe("iterateWithStallWatchdog", () => {
  it("passes the source through untouched when timeoutMs <= 0 (disabled)", async () => {
    let stalls = 0;
    const out = await collect(
      iterateWithStallWatchdog(fromArray([1, 2, 3]), 0, () => {
        stalls += 1;
      })
    );
    expect(out).toEqual([1, 2, 3]);
    expect(stalls).toBe(0);
  });

  it("yields every chunk when the source out-paces the timeout", async () => {
    let stalls = 0;
    const out = await collect(
      iterateWithStallWatchdog(fromArray(["a", "b", "c"]), 1_000, () => {
        stalls += 1;
      })
    );
    expect(out).toEqual(["a", "b", "c"]);
    expect(stalls).toBe(0);
  });

  it("throws ChatStreamStalledError and runs onStall when activity halts", async () => {
    let stalls = 0;
    // Yields one chunk, then hangs forever — the watchdog must fire.
    async function* hangsAfterFirst(): AsyncGenerator<number> {
      yield 1;
      await new Promise<void>(() => {});
      yield 2;
    }

    const guarded = iterateWithStallWatchdog(hangsAfterFirst(), 20, () => {
      stalls += 1;
    });

    const seen: number[] = [];
    let thrown: unknown;
    try {
      for await (const chunk of guarded) {
        seen.push(chunk);
      }
    } catch (err) {
      thrown = err;
    }

    expect(seen).toEqual([1]);
    expect(thrown).toBeInstanceOf(ChatStreamStalledError);
    expect((thrown as ChatStreamStalledError).isChatStreamStall).toBe(true);
    expect(stalls).toBe(1);
  });

  it("forwards consumer early-termination to the source (cancellation)", async () => {
    let returned = false;
    let stalls = 0;
    async function* tracked(): AsyncGenerator<number> {
      try {
        yield 1;
        yield 2;
        yield 3;
      } finally {
        returned = true;
      }
    }

    const guarded = iterateWithStallWatchdog(tracked(), 1_000, () => {
      stalls += 1;
    });

    for await (const chunk of guarded) {
      if (chunk === 1) break;
    }

    expect(returned).toBe(true);
    expect(stalls).toBe(0);
  });
});
