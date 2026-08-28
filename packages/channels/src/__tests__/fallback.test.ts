import { describe, expect, it, vi } from "vitest";
import {
  ChannelHost,
  fallback,
  fallbackChannel,
  type Channel,
  type ChannelChunk,
  type DeliveryResult,
  type OutboundResolver
} from "..";

function streamOf<T>(values: readonly T[], error?: unknown): ReadableStream<T> {
  let index = 0;
  return new ReadableStream<T>({
    pull(controller) {
      if (index < values.length) {
        controller.enqueue(values[index]!);
        index += 1;
        return;
      }
      if (error !== undefined) controller.error(error);
      else controller.close();
    }
  });
}

function text(...parts: string[]): ChannelChunk[] {
  return parts.map((part) => ({ type: "text", text: part }));
}

/** A Channel that records what it read, then reports a fixed outcome. */
function streamingChannel(
  result: DeliveryResult,
  options: { readAtMost?: number; available?: boolean } = {}
): Channel & { seen: ChannelChunk[]; calls: number } {
  const channel = {
    seen: [] as ChannelChunk[],
    calls: 0,
    ...(options.available === undefined
      ? {}
      : { isAvailable: () => options.available! }),
    async stream(_surface: unknown, chunks: ReadableStream<ChannelChunk>) {
      channel.calls += 1;
      const reader = chunks.getReader();
      let read = 0;
      for (;;) {
        if (read === options.readAtMost) break;
        const next = await reader.read();
        if (next.done) break;
        channel.seen.push(next.value);
        read += 1;
      }
      reader.releaseLock();
      return result;
    }
  };
  return channel as Channel & { seen: ChannelChunk[]; calls: number };
}

const rejected: DeliveryResult = {
  status: "failed",
  retryable: false,
  error: { code: "DELIVERY_FAILED", message: "Not delivered" }
};

function surface(channelKey: string) {
  return {
    channelKey,
    version: 1,
    address: null,
    label: channelKey
  } as const;
}

function channel(
  result: DeliveryResult,
  available?: boolean
): Channel & { deliver: ReturnType<typeof vi.fn> } {
  return {
    ...(available === undefined ? {} : { isAvailable: () => available }),
    deliver: vi.fn(async () => result)
  };
}

function host(channels: Record<string, Channel>) {
  return new ChannelHost({ channels, onMessage() {} });
}

describe("fallback surfaces", () => {
  it("uses the first available destination", async () => {
    const first = channel({ status: "delivered", reference: "voice-1" }, true);
    const second = channel({ status: "delivered", reference: "email-1" });
    const channelHost = host({ first, second });

    await expect(
      channelHost.deliver(fallback([surface("first"), surface("second")]), {
        markdown: "Hello"
      })
    ).resolves.toEqual({ status: "delivered", reference: "voice-1" });
    expect(second.deliver).not.toHaveBeenCalled();
  });

  it("skips unavailable destinations but always attempts the final one", async () => {
    const first = channel({ status: "delivered" }, false);
    const final = channel({ status: "delivered", reference: "email-1" }, false);
    const channelHost = host({ first, final });
    const message = { title: "Update", markdown: "Hello" };

    await expect(
      channelHost.deliver(
        fallback([surface("first"), surface("final")]),
        message
      )
    ).resolves.toEqual({ status: "delivered", reference: "email-1" });
    expect(first.deliver).not.toHaveBeenCalled();
    expect(final.deliver).toHaveBeenCalledWith(
      surface("final"),
      message,
      undefined
    );
  });

  it.each([true, false])(
    "advances after a definitive failure (retryable: %s)",
    async (retryable) => {
      const first = channel({
        status: "failed",
        retryable,
        error: { code: "DELIVERY_FAILED", message: "Not delivered" }
      });
      const second = channel({ status: "delivered", reference: "email-1" });
      const channelHost = host({ first, second });

      await expect(
        channelHost.deliver(fallback([surface("first"), surface("second")]), {
          markdown: "Hello"
        })
      ).resolves.toEqual({ status: "delivered", reference: "email-1" });
    }
  );

  it("stops after an uncertain outcome", async () => {
    const first = channel({
      status: "uncertain",
      error: { code: "DELIVERY_ERROR", message: "Unknown outcome" }
    });
    const second = channel({ status: "delivered" });
    const channelHost = host({ first, second });

    await channelHost.deliver(fallback([surface("first"), surface("second")]), {
      markdown: "Hello"
    });

    expect(first.deliver).toHaveBeenCalledOnce();
    expect(second.deliver).not.toHaveBeenCalled();
  });

  it("forwards delivery context to the resolved Channel", async () => {
    const first = channel({ status: "delivered" });
    const channelHost = host({ first });
    const message = { markdown: "Hello" };
    const options = { delivery: { deliveryId: "notice-1" } };

    await channelHost.deliver(fallback([surface("first")]), message, options);

    expect(first.deliver).toHaveBeenCalledWith(
      surface("first"),
      message,
      options
    );
  });

  it("applies the same fallback policy to approval requests", async () => {
    const first = vi.fn(async () => ({
      status: "failed" as const,
      retryable: false,
      error: { code: "NOT_SENT", message: "Not sent" }
    }));
    const second = vi.fn(async () => ({
      status: "delivered" as const,
      reference: "approval-1"
    }));
    const channelHost = host({
      first: { requestApproval: first },
      second: { requestApproval: second }
    });
    const options = {
      interactionId: "approval-1",
      request: { summary: "Proceed?", input: {} }
    };

    await expect(
      channelHost.requestApproval(
        fallback([surface("first"), surface("second")]),
        options
      )
    ).resolves.toEqual({ status: "delivered", reference: "approval-1" });
    expect(second).toHaveBeenCalledWith(surface("second"), options);
  });

  it("treats a configured inbound-only Channel as a confirmed failure", async () => {
    const second = channel({ status: "delivered", reference: "email-1" });
    const channelHost = host({ inbound: {}, second });

    await expect(
      channelHost.deliver(fallback([surface("inbound"), surface("second")]), {
        markdown: "Hello"
      })
    ).resolves.toEqual({ status: "delivered", reference: "email-1" });
  });

  it("runs as an ordinary Channel against an injected outbound resolver", async () => {
    const resolver = {
      deliver: vi.fn(async () => ({ status: "delivered" as const })),
      requestApproval: vi.fn(async () => ({ status: "delivered" as const })),
      isAvailable: vi.fn(async () => true)
    } satisfies OutboundResolver;
    const policy = fallbackChannel(resolver);
    const destination = fallback([surface("first")]);
    const message = { markdown: "Hello" };

    await expect(policy.deliver?.(destination, message)).resolves.toEqual({
      status: "delivered"
    });
    expect(resolver.deliver).toHaveBeenCalledWith(
      surface("first"),
      message,
      undefined
    );
  });

  it("constructs labelled inert data without consulting configured Channels", () => {
    expect(fallback([surface("Slack"), surface("email")])).toEqual({
      channelKey: "fallback",
      version: 1,
      address: { surfaces: [surface("Slack"), surface("email")] },
      label: "Slack, then email"
    });
  });
});

describe("fallback streaming", () => {
  it("replays what a failed destination consumed to the next one", async () => {
    const first = streamingChannel(rejected);
    const second = streamingChannel({ status: "delivered", reference: "s-1" });
    const channelHost = host({ first, second });

    await expect(
      channelHost.stream(
        fallback([surface("first"), surface("second")]),
        streamOf(text("Hello ", "world"))
      )
    ).resolves.toEqual({ status: "delivered", reference: "s-1" });
    expect(second.seen).toEqual([
      { type: "text", text: "Hello " },
      { type: "text", text: "world" }
    ]);
    expect(second.seen).toEqual(first.seen);
  });

  it("replays the consumed prefix and streams the untouched remainder", async () => {
    const first = streamingChannel(rejected, { readAtMost: 1 });
    const second = streamingChannel({ status: "delivered" });
    const channelHost = host({ first, second });

    await channelHost.stream(
      fallback([surface("first"), surface("second")]),
      streamOf(text("one", "two", "three"))
    );

    expect(first.seen).toEqual([{ type: "text", text: "one" }]);
    expect(second.seen).toEqual([
      { type: "text", text: "one" },
      { type: "text", text: "two" },
      { type: "text", text: "three" }
    ]);
  });

  it("skips an unavailable destination without consuming the stream", async () => {
    const skipped = streamingChannel(
      { status: "delivered" },
      {
        available: false
      }
    );
    const final = streamingChannel({ status: "delivered", reference: "f-1" });
    const channelHost = host({ skipped, final });

    await expect(
      channelHost.stream(
        fallback([surface("skipped"), surface("final")]),
        streamOf(text("Hello"))
      )
    ).resolves.toEqual({ status: "delivered", reference: "f-1" });
    expect(skipped.calls).toBe(0);
    expect(final.seen).toEqual([{ type: "text", text: "Hello" }]);
  });

  it("stops after an uncertain streaming outcome", async () => {
    const first = streamingChannel({
      status: "uncertain",
      reference: "half-written",
      error: { code: "STREAM_ERROR", message: "Partly sent" }
    });
    const second = streamingChannel({ status: "delivered" });
    const channelHost = host({ first, second });

    await expect(
      channelHost.stream(
        fallback([surface("first"), surface("second")]),
        streamOf(text("Hello"))
      )
    ).resolves.toEqual({
      status: "uncertain",
      reference: "half-written",
      error: { code: "STREAM_ERROR", message: "Partly sent" }
    });
    expect(second.calls).toBe(0);
  });

  it("attempts the final destination even after every earlier one failed", async () => {
    const first = streamingChannel(rejected);
    const second = streamingChannel(rejected);
    const channelHost = host({ first, second });

    await expect(
      channelHost.stream(
        fallback([surface("first"), surface("second")]),
        streamOf(text("Hello"))
      )
    ).resolves.toEqual(rejected);
    expect(second.seen).toEqual([{ type: "text", text: "Hello" }]);
  });

  it("replays into a destination that cannot stream", async () => {
    const deliver = vi.fn(async () => ({ status: "delivered" as const }));
    const first = streamingChannel(rejected);
    const channelHost = host({ first, second: { deliver } });

    await expect(
      channelHost.stream(
        fallback([surface("first"), surface("second")]),
        streamOf(text("Hello ", "world")),
        { title: "Update" }
      )
    ).resolves.toEqual({ status: "delivered" });
    expect(deliver).toHaveBeenCalledWith(
      surface("second"),
      { title: "Update", markdown: "Hello world" },
      undefined
    );
  });

  it("passes an interrupted generation on to the destination", async () => {
    const seen: ChannelChunk[] = [];
    let interrupted = false;
    const channelHost = host({
      only: {
        async stream(_surface, chunks) {
          try {
            for await (const chunk of chunks) seen.push(chunk);
          } catch {
            interrupted = true;
          }
          return { status: "uncertain", error: { code: "X", message: "y" } };
        }
      }
    });

    await channelHost.stream(
      fallback([surface("only")]),
      streamOf(text("Half an "), new Error("model failed"))
    );

    expect(seen).toEqual([{ type: "text", text: "Half an " }]);
    expect(interrupted).toBe(true);
  });
});
