import { describe, expect, it } from "vitest";
import {
  CONTEXT_METADATA_KEY,
  Context,
  type ContextConfig
} from "../../context";
import { Sessions, type Session, type SessionMessage } from "../../sessions";
import { withCapabilityHarness } from "../shared/capability-harness";

/**
 * `Context` over a real Sessions capability: the transcript records the
 * prompt the model was sent and the changes delivered after it, and each
 * request is a projection of that record.
 */

function user(id: string, text: string): SessionMessage {
  return { id, role: "user", parts: [{ type: "text", text }] };
}

function assistant(id: string, text: string): SessionMessage {
  return { id, role: "assistant", parts: [{ type: "text", text }] };
}

function texts(message: SessionMessage | undefined): string[] {
  return (message?.parts ?? []).map((part) => part.text ?? "");
}

/** A session plus a remind block whose value the test controls. */
async function setup(
  storage: DurableObjectStorage,
  install: (sessions: Sessions) => void,
  extra: ContextConfig[] = []
): Promise<{
  session: Session;
  context: Context;
  setDate: (date: string) => void;
}> {
  const sessions = new Sessions();
  install(sessions);
  const session = sessions.session();
  let date = "Monday";
  const context = new Context(session, {
    storage,
    blocks: [
      { label: "soul", provider: { get: async () => "You are helpful." } },
      {
        label: "environment",
        provider: { get: async () => `Today is ${date}.` },
        whenChanged: "remind"
      },
      ...extra
    ]
  });
  return { session, context, setDate: (next) => (date = next) };
}

describe("Context", () => {
  it("records the first prompt on the user message and reuses it", async () => {
    await withCapabilityHarness(async ({ storage, install }) => {
      const { session, context } = await setup(storage, (s) => install(s));
      await session.appendMessage(user("u1", "hello"));

      const first = await context.build();
      expect(first.system).toContain("You are helpful.");
      expect(first.system).toContain("Today is Monday.");
      const stored = await session.getMessage("u1");
      expect(stored?.metadata).toHaveProperty(CONTEXT_METADATA_KEY);

      await session.appendMessage(assistant("a1", "hi"));
      await session.appendMessage(user("u2", "again"));
      const second = await context.build();
      expect(second.system).toBe(first.system);
      // Only the first user message carries a record.
      expect((await session.getMessage("u2"))?.metadata).toBeUndefined();
    });
  });

  it("delivers a changed remind block once, after the user message that noticed it", async () => {
    await withCapabilityHarness(async ({ storage, install }) => {
      const { session, context, setDate } = await setup(storage, (s) =>
        install(s)
      );
      await session.appendMessage(user("u1", "hello"));
      const first = await context.build();

      await session.appendMessage(assistant("a1", "hi"));
      await session.appendMessage(user("u2", "what day is it?"));
      setDate("Tuesday");
      const second = await context.build();
      expect(second.system).toBe(first.system);
      expect(second.reminder).toBeNull();
      const last = second.messages.at(-1);
      expect(texts(last)[0]).toBe("what day is it?");
      expect(texts(last)[1]).toContain("Today is Tuesday.");

      // The next turn renders the earlier request unchanged and adds
      // nothing new: the request extends the previous one.
      await session.appendMessage(assistant("a2", "Tuesday"));
      await session.appendMessage(user("u3", "thanks"));
      const third = await context.build();
      expect(third.system).toBe(first.system);
      expect(third.messages.slice(0, second.messages.length)).toEqual(
        second.messages
      );
      expect(texts(third.messages.at(-1))).toEqual(["thanks"]);
    });
  });

  it("takes a new snapshot on the next turn after a refresh", async () => {
    await withCapabilityHarness(async ({ storage, install }) => {
      const { session, context, setDate } = await setup(storage, (s) =>
        install(s)
      );
      await session.appendMessage(user("u1", "hello"));
      const first = await context.build();

      setDate("Wednesday");
      const refreshed = await context.refreshSystemPrompt();
      expect(refreshed).toContain("Wednesday");
      // Nothing is recorded until a turn ends with a user message.
      expect(await context.freezeSystemPrompt()).toBe(refreshed);

      await session.appendMessage(assistant("a1", "hi"));
      await session.appendMessage(user("u2", "again"));
      const second = await context.build();
      expect(second.system).not.toBe(first.system);
      expect(second.system).toContain("Wednesday");
      expect(second.reminder).toBeNull();
    });
  });

  it("hands back a reminder it cannot record when the history ends elsewhere", async () => {
    await withCapabilityHarness(async ({ storage, install }) => {
      const { session, context, setDate } = await setup(storage, (s) =>
        install(s)
      );
      await session.appendMessage(user("u1", "hello"));
      await context.build();
      await session.appendMessage(assistant("a1", "partial"));

      setDate("Thursday");
      const continued = await context.build();
      expect(continued.reminder).toContain("Today is Thursday.");
      expect((await session.getMessage("a1"))?.metadata).toBeUndefined();

      // The next user turn records it.
      await session.appendMessage(user("u2", "go on"));
      const next = await context.build();
      expect(next.reminder).toBeNull();
      expect(texts(next.messages.at(-1))[1]).toContain("Today is Thursday.");
    });
  });

  it("stores blocks without a provider and shows writes at the next refresh", async () => {
    await withCapabilityHarness(async ({ storage, install }) => {
      const { session, context } = await setup(storage, (s) => install(s), [
        { label: "memory", description: "Learned facts" }
      ]);
      await session.appendMessage(user("u1", "hello"));
      const first = await context.build();
      expect(first.system).toContain("MEMORY (Learned facts)");

      await context.setBlock("memory", "likes tea");
      expect(await context.freezeSystemPrompt()).toBe(first.system);
      expect(Object.keys(await context.tools())).toContain("set_context");

      expect(await context.refreshSystemPrompt()).toContain("likes tea");
      const rows = storage.sql
        .exec<{ content: string }>(
          "SELECT content FROM cf_agents_context_blocks WHERE label = 'memory'"
        )
        .toArray();
      expect(rows[0]?.content).toBe("likes tea");
    });
  });

  it("takes a new snapshot when compaction hides the old one", async () => {
    await withCapabilityHarness(async ({ storage, install }) => {
      const { session, context, setDate } = await setup(storage, (s) =>
        install(s)
      );
      await session.appendMessage(user("u1", "hello"));
      const first = await context.build();
      await session.appendMessage(assistant("a1", "hi"));
      await session.appendMessage(user("u2", "more"));
      await session.addCompaction("earlier turns", "u1", "a1");

      setDate("Friday");
      const after = await context.build();
      expect(after.system).not.toBe(first.system);
      expect(after.system).toContain("Today is Friday.");
    });
  });

  it("projects the same history to the same messages", async () => {
    await withCapabilityHarness(async ({ storage, install }) => {
      const { session, context, setDate } = await setup(storage, (s) =>
        install(s)
      );
      await session.appendMessage(user("u1", "hello"));
      await context.build();
      setDate("Saturday");
      await session.appendMessage(assistant("a1", "hi"));
      await session.appendMessage(user("u2", "day?"));
      await context.build();

      const history = await session.getHistory();
      expect(context.project(history)).toEqual(context.project(history));
      // Reading the prompt writes nothing.
      const before = JSON.stringify(await session.getHistory());
      await context.freezeSystemPrompt();
      await context.reminder();
      expect(JSON.stringify(await session.getHistory())).toBe(before);
    });
  });
});
