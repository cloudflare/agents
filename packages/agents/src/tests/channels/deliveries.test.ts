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
    expect(emails).toEqual([
      { to: "alice@example.com", subject: "Re: Question", text: "Hello" }
    ]);
    expect(await stub.getPosts()).toEqual([]);
  });
});
