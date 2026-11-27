import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type {
  ChannelMessageSurface,
  ResponseChunk,
  SessionEvent
} from "../../experimental/channels";
import type {
  ChannelsDeliveryObject,
  FakePost
} from "../capabilities/channels";

type Stub = DurableObjectStub<ChannelsDeliveryObject>;

const chunk = (c: ResponseChunk): SessionEvent => ({ type: "chunk", chunk: c });

async function until<T>(
  read: () => Promise<T>,
  done: (value: T) => boolean,
  timeoutMs = 15_000
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    // A call the object's reset cut short fails; the next one restarts it.
    const value = await read().catch(() => undefined);
    if (value !== undefined && done(value)) return value;
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** A message from the `t1` thread; then one response "Hello" for it. */
async function answer(
  stub: Stub,
  script: FakePost[] = [],
  surfaceOf: (stub: Stub) => Promise<ChannelMessageSurface> = (s) =>
    s.surfaceOf("t1")
): Promise<void> {
  await stub.setScript(script);
  const surface = await surfaceOf(stub);
  await stub.receive(
    {
      type: "message",
      eventId: "e1",
      message: {
        id: "e1",
        role: "user",
        parts: [{ type: "text", text: "hi" }]
      }
    },
    { route: "default", participant: { id: "alice" }, surface }
  );
  await stub.emit([
    { type: "run-start", operations: ["e1"] },
    chunk({ type: "text-start", id: "a" }),
    chunk({ type: "text-delta", id: "a", delta: "Hel" }),
    chunk({ type: "text-delta", id: "a", delta: "lo" }),
    chunk({ type: "text-end", id: "a" }),
    { type: "run-end", operations: ["e1"] }
  ]);
}

function fresh(): Stub {
  return env.ChannelsDeliveryObject.getByName(crypto.randomUUID());
}

describe("deliverToSurfaces", () => {
  it("streams a conversation's response to a gateway surface that joined it, once", async () => {
    const stub = fresh();
    await answer(stub);
    const posts = await until(
      () => stub.getPosts(),
      (p) => p.length === 1
    );
    expect(posts).toEqual([{ label: "t1", text: "Hello", outcome: "ok" }]);
    await until(
      () => stub.openDeliveries(),
      (n) => n === 0
    );
  });

  it("tries a retryable failure again, with backoff, until the Channel delivers", async () => {
    const stub = fresh();
    await answer(stub, ["retryable"]);
    const posts = await until(
      () => stub.getPosts(),
      (p) => p.length === 2
    );
    expect(posts.map((p) => [p.text, p.outcome])).toEqual([
      ["Hello", "retryable"],
      ["Hello", "ok"]
    ]);
    await until(
      () => stub.openDeliveries(),
      (n) => n === 0
    );
  });

  it.each(["refused", "uncertain"] as const)(
    "gives up at once, posting nothing more, when the Channel says %s",
    async (outcome) => {
      const stub = fresh();
      await answer(stub, [outcome]);
      await until(
        () => stub.openDeliveries(),
        (n) => n === 0
      );
      expect((await stub.getPosts()).map((p) => p.outcome)).toEqual([outcome]);
    }
  );

  it("gives up after the object reset mid-post, instead of posting the response again", async () => {
    const name = crypto.randomUUID();
    // A stub whose object reset stays broken: each read takes a new one.
    const stub = () => env.ChannelsDeliveryObject.getByName(name);
    await answer(stub(), ["reset"]).catch(() => {});
    await until(
      () => stub().openDeliveries(),
      (n) => n === 0,
      30_000
    );
    expect((await stub().getPosts()).map((p) => p.outcome)).toEqual(["reset"]);
  }, 40_000);

  it("posts once more when the object reset before the post left it", async () => {
    const name = crypto.randomUUID();
    const stub = () => env.ChannelsDeliveryObject.getByName(name);
    await answer(stub(), ["reset-before-send"]).catch(() => {});
    await until(
      () => stub().openDeliveries(),
      (n) => n === 0,
      30_000
    );
    expect((await stub().getPosts()).map((p) => [p.text, p.outcome])).toEqual([
      ["Hello", "ok"]
    ]);
  }, 40_000);

  it("posts once more when the object reset after only a preview went out", async () => {
    const name = crypto.randomUUID();
    const stub = () => env.ChannelsDeliveryObject.getByName(name);
    await answer(stub(), ["reset-after-preview"]).catch(() => {});
    await until(
      () => stub().openDeliveries(),
      (n) => n === 0,
      30_000
    );
    expect((await stub().getPosts()).map((p) => [p.text, p.outcome])).toEqual([
      ["Hello", "ok"]
    ]);
  }, 40_000);

  it("posts no notice for a run cut off before it wrote, once a later run answers its turn", async () => {
    const stub = fresh();
    // The notice the cut-off response would post fails once, so its delivery
    // tries again after the turn's later run opened its response.
    await stub.setScript(["retryable"]);
    await stub.receive(
      {
        type: "message",
        eventId: "e1",
        message: {
          id: "e1",
          role: "user",
          parts: [{ type: "text", text: "hi" }]
        }
      },
      {
        route: "default",
        participant: { id: "alice" },
        surface: await stub.surfaceOf("t1")
      }
    );
    await stub.emit([{ type: "run-start", operations: ["e1"] }]);
    await stub.wake();
    await stub.emit([
      { type: "run-start", operations: ["e1"] },
      chunk({ type: "text-start", id: "a" }),
      chunk({ type: "text-delta", id: "a", delta: "Hello" }),
      chunk({ type: "text-end", id: "a" }),
      { type: "run-end", operations: ["e1"] }
    ]);
    await until(
      () => stub.openDeliveries(),
      (n) => n === 0
    );
    const posts = await stub.getPosts();
    expect(posts.some((p) => p.text === "Hello" && p.outcome === "ok")).toBe(
      true
    );
    // The fake records a stream that broke off as `uncertain`: the cut-off
    // response's retry read it as ended empty instead.
    expect(posts.map((p) => p.outcome)).not.toContain("uncertain");
  });

  it("posts nothing of a run cut off mid-answer, once a later run answers its turn", async () => {
    const stub = fresh();
    // The cut-off response's post fails once, so its delivery tries again
    // after the turn's later run opened its response.
    await stub.setScript(["retryable"]);
    await stub.receive(
      {
        type: "message",
        eventId: "e1",
        message: {
          id: "e1",
          role: "user",
          parts: [{ type: "text", text: "hi" }]
        }
      },
      {
        route: "default",
        participant: { id: "alice" },
        surface: await stub.surfaceOf("t1")
      }
    );
    await stub.emit([
      { type: "run-start", operations: ["e1"] },
      chunk({ type: "text-start", id: "a" }),
      chunk({ type: "text-delta", id: "a", delta: "Hel" })
    ]);
    await stub.wake();
    await stub.emit([
      { type: "run-start", operations: ["e1"] },
      chunk({ type: "text-start", id: "b" }),
      chunk({ type: "text-delta", id: "b", delta: "Hello" }),
      chunk({ type: "text-end", id: "b" }),
      { type: "run-end", operations: ["e1"] }
    ]);
    await until(
      () => stub.openDeliveries(),
      (n) => n === 0
    );
    const posts = await stub.getPosts();
    // Only the first, failed post had the cut-off text.
    expect(posts.filter((p) => p.text === "Hel").map((p) => p.outcome)).toEqual(
      ["retryable"]
    );
    expect(posts.some((p) => p.text === "Hello" && p.outcome === "ok")).toBe(
      true
    );
  });

  it("still posts a cut-off run's finished step, which a later run does not repeat", async () => {
    const stub = fresh();
    await stub.setScript(["retryable"]);
    await stub.receive(
      {
        type: "message",
        eventId: "e1",
        message: {
          id: "e1",
          role: "user",
          parts: [{ type: "text", text: "hi" }]
        }
      },
      {
        route: "default",
        participant: { id: "alice" },
        surface: await stub.surfaceOf("t1")
      }
    );
    await stub.emit([
      { type: "run-start", operations: ["e1"] },
      chunk({ type: "text-start", id: "a" }),
      chunk({ type: "text-delta", id: "a", delta: "Step one." }),
      chunk({ type: "text-end", id: "a" }),
      chunk({ type: "text-start", id: "b" }),
      chunk({ type: "text-delta", id: "b", delta: "Hel" })
    ]);
    await stub.wake();
    await stub.emit([
      { type: "run-start", operations: ["e1"] },
      chunk({ type: "text-start", id: "c" }),
      chunk({ type: "text-delta", id: "c", delta: "Hello" }),
      chunk({ type: "text-end", id: "c" }),
      { type: "run-end", operations: ["e1"] }
    ]);
    await until(
      () => stub.openDeliveries(),
      (n) => n === 0
    );
    const posts = await stub.getPosts();
    // Tried again after the later run began, the cut response is still
    // posted (as cut off), so its finished step reaches the reader.
    expect(
      posts.some(
        (p) => p.text.startsWith("Step one.") && p.outcome === "uncertain"
      )
    ).toBe(true);
    expect(posts.some((p) => p.text === "Hello" && p.outcome === "ok")).toBe(
      true
    );
  });

  it("delivers the response as one email to an email surface, through the email Channel", async () => {
    const stub = fresh();
    await answer(stub, [], async () => ({
      version: 1,
      channelKey: "email",
      address: {
        from: "agent@example.com",
        to: "alice@example.com",
        subject: "Question"
      },
      label: "Email · alice@example.com"
    }));
    const emails = await until(
      () => stub.getEmails(),
      (e) => e.length === 1
    );
    expect(emails).toMatchObject([
      { to: "alice@example.com", subject: "Re: Question", text: "Hello" }
    ]);
    expect(await stub.getPosts()).toEqual([]);
  });

  it("sends one email per response to a thread that wrote twice, answering its latest message", async () => {
    const stub = fresh();
    const mail = (inReplyTo: string): ChannelMessageSurface => ({
      version: 1,
      channelKey: "email",
      address: {
        from: "agent@example.com",
        to: "alice@example.com",
        subject: "Question",
        inReplyTo
      },
      label: "Email · alice@example.com",
      key: "thread-root"
    });
    for (const [eventId, inReplyTo] of [
      ["m1", "m-1"],
      ["m2", "m-2"]
    ]) {
      await stub.receive(
        {
          type: "message",
          eventId,
          message: {
            id: eventId,
            role: "user",
            parts: [{ type: "text", text: "hi" }]
          }
        },
        {
          route: "default",
          participant: { id: "alice" },
          surface: mail(inReplyTo)
        }
      );
    }
    await stub.emit([
      { type: "run-start", operations: ["m1", "m2"] },
      chunk({ type: "text-start", id: "a" }),
      chunk({ type: "text-delta", id: "a", delta: "Hello" }),
      chunk({ type: "text-end", id: "a" }),
      { type: "run-end", operations: ["m1", "m2"] }
    ]);
    const emails = await until(
      () => stub.getEmails(),
      (e) => e.length >= 1
    );
    await until(
      () => stub.openDeliveries(),
      (n) => n === 0
    );
    expect(await stub.getEmails()).toEqual([
      expect.objectContaining({ text: "Hello", inReplyTo: "<m-2>" })
    ]);
    expect(emails).toHaveLength(1);
  });

  it("emails a response only once it has ended, and not at all without text", async () => {
    const stub = fresh();
    await stub.receive(
      {
        type: "message",
        eventId: "e1",
        message: {
          id: "e1",
          role: "user",
          parts: [{ type: "text", text: "hi" }]
        }
      },
      {
        route: "default",
        participant: { id: "alice" },
        surface: {
          version: 1,
          channelKey: "email",
          address: { from: "agent@example.com", to: "alice@example.com" },
          label: "Email · alice@example.com"
        }
      }
    );
    await stub.emit([
      { type: "run-start", operations: ["e1"] },
      chunk({ type: "text-start", id: "a" })
    ]);
    // Still running: the delivery waits for the response, nothing is sent.
    await until(
      () => stub.openDeliveries(),
      (n) => n === 1
    );
    expect(await stub.getEmails()).toEqual([]);
    await stub.emit([
      chunk({ type: "text-end", id: "a" }),
      { type: "run-end", operations: ["e1"] }
    ]);
    await until(
      () => stub.openDeliveries(),
      (n) => n === 0
    );
    expect(await stub.getEmails()).toEqual([]);
  });

  it("emails what an interrupted response produced, once, and does not send it again", async () => {
    const stub = fresh();
    await stub.receive(
      {
        type: "message",
        eventId: "e1",
        message: {
          id: "e1",
          role: "user",
          parts: [{ type: "text", text: "hi" }]
        }
      },
      {
        route: "default",
        participant: { id: "alice" },
        surface: {
          version: 1,
          channelKey: "email",
          address: { from: "agent@example.com", to: "alice@example.com" },
          label: "Email · alice@example.com"
        }
      }
    );
    await stub.emit([
      { type: "run-start", operations: ["e1"] },
      chunk({ type: "text-start", id: "a" }),
      chunk({ type: "text-delta", id: "a", delta: "Hel" })
    ]);
    // A new instance finds the response still streaming: interrupted.
    await stub.wake();
    // The turn ends without another run: what the cut response held is all
    // there is.
    await stub.emit([
      { type: "operation", status: { operationId: "e1", status: "unanswered" } }
    ]);
    await until(
      () => stub.getEmails(),
      (e) => e.length === 1
    );
    await until(
      () => stub.openDeliveries(),
      (n) => n === 0
    );
    expect(await stub.getEmails()).toEqual([
      expect.objectContaining({ text: "Hel" })
    ]);
  });

  it("retries a send that threw: nothing reached the reader", async () => {
    const stub = fresh();
    await answer(stub, [], async () => ({
      version: 1,
      channelKey: "thrower",
      address: { to: "x" },
      label: "Thrower"
    }));
    await until(
      () => stub.getThrown(),
      (sent) => sent.length === 1
    );
    expect(await stub.getThrown()).toEqual(["Hello"]);
  });

  it("emails a notice for a response interrupted before it wrote anything", async () => {
    const stub = fresh();
    await stub.receive(
      {
        type: "message",
        eventId: "e1",
        message: {
          id: "e1",
          role: "user",
          parts: [{ type: "text", text: "hi" }]
        }
      },
      {
        route: "default",
        participant: { id: "alice" },
        surface: {
          version: 1,
          channelKey: "email",
          address: { from: "agent@example.com", to: "alice@example.com" },
          label: "Email · alice@example.com"
        }
      }
    );
    await stub.emit([{ type: "run-start", operations: ["e1"] }]);
    await stub.wake();
    // The turn ends without another run: what the cut response held is all
    // there is.
    await stub.emit([
      { type: "operation", status: { operationId: "e1", status: "unanswered" } }
    ]);
    const emails = await until(
      () => stub.getEmails(),
      (e) => e.length === 1
    );
    expect(emails[0].text).toMatch(/^The answer was interrupted/);
  });

  it("streams the response to a Chat SDK thread through its adapter", async () => {
    const stub = fresh();
    await answer(stub, [], async () => ({
      version: 1,
      channelKey: "chat",
      address: { threadId: "fakechat:42" },
      label: "fakechat · fakechat:42",
      key: "fakechat:42"
    }));
    const posts = await until(
      () => stub.getChatPosts(),
      (p) => p.length === 1
    );
    expect(posts).toEqual([{ threadId: "fakechat:42", text: "Hello" }]);
  });
});
