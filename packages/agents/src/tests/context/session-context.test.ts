import { describe, expect, it } from "vitest";
import {
  AgentSearchProvider,
  Context,
  type ContextConfig,
  type SqlProvider
} from "../../context";
import { Sessions, type Session, type SessionMessage } from "../../sessions";
import { withCapabilityHarness } from "../shared/capability-harness";

/**
 * `Context` over a real Sessions capability: the transcript records the
 * prompt the model was sent and the changes delivered after it, and each
 * request is a projection of that record.
 */

/** A context tool's executor, called as the model would call it. */
type ToolFn = { execute: (input: Record<string, unknown>) => Promise<string> };

async function callTool(
  context: Context,
  name: string,
  input: Record<string, unknown>
): Promise<string> {
  const tools = await context.tools();
  return (tools[name] as unknown as ToolFn).execute(input);
}

/** The tagged-template SQL the search provider takes, over DO storage. */
function storageSql(storage: DurableObjectStorage): SqlProvider {
  return {
    sql: <T>(
      strings: TemplateStringsArray,
      ...values: (string | number | boolean | null)[]
    ) => [...storage.sql.exec(strings.join("?"), ...values)] as T[]
  };
}

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
    sql: storageSql(storage),
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
      // The record is a session annotation; the message itself is untouched.
      expect((await session.getMessage("u1"))?.metadata).toBeUndefined();
      expect(
        (await session.internal_annotations("context", ["u1"])).has("u1")
      ).toBe(true);

      await session.appendMessage(assistant("a1", "hi"));
      await session.appendMessage(user("u2", "again"));
      const second = await context.build();
      expect(second.system).toBe(first.system);
      // A turn that delivers nothing new writes nothing.
      expect((await session.internal_annotations("context", ["u2"])).size).toBe(
        0
      );
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
      expect((await session.internal_annotations("context", ["a1"])).size).toBe(
        0
      );

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

  it("keeps the prompt when compaction hides its snapshot, until a refresh", async () => {
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
      expect(after.system).toBe(first.system);
      // The change still reaches the model, after u2.
      expect(texts(after.messages.at(-1))[1]).toContain("Today is Friday.");

      await context.refreshSystemPrompt();
      await session.appendMessage(assistant("a2", "ok"));
      await session.appendMessage(user("u3", "and now?"));
      expect((await context.build()).system).toContain("Today is Friday.");
    });
  });

  it("keeps a refresh across a cold wake", async () => {
    await withCapabilityHarness(async ({ storage, install }) => {
      const first = await setup(storage, (s) => install(s));
      await first.session.appendMessage(user("u1", "hello"));
      await first.context.build();
      first.setDate("Sunday");
      await first.context.refreshSystemPrompt();

      // A new Context on the same storage, as after an eviction.
      const woken = await setup(storage, (s) => install(s));
      woken.setDate("Sunday");
      await woken.session.appendMessage(assistant("a1", "hi"));
      await woken.session.appendMessage(user("u2", "again"));
      expect((await woken.context.build()).system).toContain(
        "Today is Sunday."
      );
    });
  });

  it("finds the snapshot when the history starts after it", async () => {
    await withCapabilityHarness(async ({ storage, install }) => {
      const { session, context } = await setup(storage, (s) => install(s));
      await session.appendMessage(user("u1", "hello"));
      const first = await context.build();
      await session.appendMessage(assistant("a1", "hi"));
      await session.appendMessage(user("u2", "again"));

      // A host's bounded window that no longer reaches u1.
      const window = (await session.getHistory()).slice(-1);
      const prepared = await context.prepare({ messages: window });
      expect(prepared.system).toBe(first.system);
    });
  });

  it("gives a regenerated earlier turn the prompt its own branch was sent with", async () => {
    await withCapabilityHarness(async ({ storage, install }) => {
      const { session, context, setDate } = await setup(storage, (s) =>
        install(s)
      );
      await session.appendMessage(user("u1", "hello"));
      const monday = await context.build();
      await session.appendMessage(assistant("a1", "hi"));
      await session.appendMessage(user("u2", "plan my week"));
      await context.build();
      await session.appendMessage(assistant("a2", "here is a plan"));

      setDate("Friday");
      await context.refreshSystemPrompt();
      await session.appendMessage(user("u3", "and now?"));
      const friday = await context.build();
      expect(friday.system).toContain("Today is Friday.");

      // Regenerate a2 from a window that holds only u2: the snapshot from
      // u3 came later, so u2 keeps the prompt it was first sent with.
      const regenerated = await context.prepare({
        messages: [(await session.getMessage("u2"))!]
      });
      expect(regenerated.system).toBe(monday.system);
    });
  });

  it("keeps a block whose label looks like an internal one", async () => {
    await withCapabilityHarness(async ({ storage, install }) => {
      const { session, context } = await setup(storage, (s) => install(s), [
        { label: "_context_state" }
      ]);
      await session.appendMessage(user("u1", "hello"));
      await context.build();
      await context.setBlock("_context_state", "kept");
      await context.refreshSystemPrompt();
      await session.appendMessage(assistant("a1", "hi"));
      await session.appendMessage(user("u2", "again"));
      await context.build();
      expect(context.getBlock("_context_state")?.content).toBe("kept");
    });
  });

  it("gives an old turn its own prompt however many changes came after it", async () => {
    await withCapabilityHarness(async ({ storage, install }) => {
      const { session, context, setDate } = await setup(storage, (s) =>
        install(s)
      );
      await session.appendMessage(user("u1", "hello"));
      const monday = await context.build();
      await session.appendMessage(assistant("a1", "hi"));
      await session.appendMessage(user("u2", "plan my week"));
      await context.build();
      await session.appendMessage(assistant("a2", "a plan"));
      // Many later turns, each delivering a change.
      for (let turn = 0; turn < 300; turn++) {
        setDate(`day ${turn}`);
        await session.appendMessage(user(`q${turn}`, "and now?"));
        await context.build();
        await session.appendMessage(assistant(`r${turn}`, "noted"));
      }

      const regenerated = await context.prepare({
        messages: [(await session.getMessage("u2"))!]
      });
      expect(regenerated.system).toBe(monday.system);
    });
  });

  it("keeps the prompt when compaction reaches the last message", async () => {
    await withCapabilityHarness(async ({ storage, install }) => {
      const { session, context, setDate } = await setup(storage, (s) =>
        install(s)
      );
      await session.appendMessage(user("u1", "hello"));
      const monday = await context.build();
      await session.appendMessage(assistant("a1", "hi"));
      await session.addCompaction("everything so far", "u1", "a1");

      setDate("Friday");
      expect(await context.freezeSystemPrompt()).toBe(monday.system);
      expect(await context.reminder()).toContain("Today is Friday.");
    });
  });

  it("does not record on a user message that already has an answer", async () => {
    await withCapabilityHarness(async ({ storage, install }) => {
      const { session, context, setDate } = await setup(storage, (s) =>
        install(s)
      );
      await session.appendMessage(user("u1", "hello"));
      await context.build();
      const recorded = await session.internal_annotations("context", ["u1"]);
      await session.appendMessage(assistant("a1", "hi"));

      // Regenerating a1 answers u1 again.
      setDate("Tuesday");
      const prepared = await context.prepare({
        messages: [(await session.getMessage("u1"))!]
      });
      expect(prepared.reminder).toContain("Today is Tuesday.");
      expect(await session.internal_annotations("context", ["u1"])).toEqual(
        recorded
      );
    });
  });

  it("lets the model index and search a searchable block", async () => {
    await withCapabilityHarness(async ({ storage, install }) => {
      const { session, context } = await setup(storage, (s) => install(s), [
        {
          label: "notes",
          description: "Things worth looking up later",
          provider: new AgentSearchProvider(storageSql(storage))
        }
      ]);
      await session.appendMessage(user("u1", "remember this"));
      const first = await context.build();
      expect(first.system).toContain(
        "NOTES (Things worth looking up later) [searchable]"
      );

      expect(
        await callTool(context, "set_context", {
          label: "notes",
          content: "Durable Objects keep SQLite next to compute.",
          metadata: { title: "storage" }
        })
      ).toBe('Indexed "storage" in notes.');
      expect(
        await callTool(context, "search_context", {
          label: "notes",
          query: "SQLite"
        })
      ).toContain("Durable Objects keep SQLite next to compute.");
      expect(
        await callTool(context, "search_context", {
          label: "notes",
          query: "Kubernetes"
        })
      ).toBe("No results found.");

      expect(await context.refreshSystemPrompt()).toContain(
        "1 entries indexed."
      );
    });
  });

  it("refuses writes to read-only blocks and past a block's token budget", async () => {
    await withCapabilityHarness(async ({ storage, install }) => {
      const { session, context } = await setup(storage, (s) => install(s), [
        { label: "memory", description: "Learned facts", maxTokens: 5 }
      ]);
      await session.appendMessage(user("u1", "hello"));
      await context.build();

      await expect(context.setBlock("soul", "Be rude.")).rejects.toThrow(
        /readonly/
      );
      expect(
        await callTool(context, "set_context", {
          label: "memory",
          content: "a fact far too long for a five token budget to hold"
        })
      ).toMatch(/^Error: .*exceeds maxTokens/);
      expect(
        await callTool(context, "set_context", {
          label: "memory",
          content: "tea"
        })
      ).toMatch(/^Written to memory/);
      expect(context.getBlock("memory")?.content).toBe("tea");
    });
  });

  it("restates a change that compaction hid from the model", async () => {
    await withCapabilityHarness(async ({ storage, install }) => {
      const { session, context, setDate } = await setup(storage, (s) =>
        install(s)
      );
      await session.appendMessage(user("u1", "hello"));
      const first = await context.build();
      await session.appendMessage(assistant("a1", "hi"));
      setDate("Tuesday");
      await session.appendMessage(user("u2", "what day?"));
      await context.build();
      await session.appendMessage(assistant("a2", "Tuesday"));
      await session.appendMessage(user("u3", "more"));
      await context.build();
      await session.appendMessage(assistant("a3", "ok"));
      // The summary hides u1..a2, including the turn that delivered Tuesday.
      await session.addCompaction("earlier turns", "u1", "a2");

      await session.appendMessage(user("u4", "and now?"));
      const after = await context.build();
      expect(after.system).toBe(first.system);
      const sent = JSON.stringify(after.messages);
      expect(sent.split("Today is Tuesday.").length - 1).toBe(1);
      // Restated right after the summary, and in the same place next time.
      // (Compare what the model is sent: an overlay's createdAt is set when
      // Sessions reads it.)
      const again = await context.build();
      const shape = (m: typeof again.messages) =>
        m.map(({ id, role, parts }) => ({ id, role, parts }));
      expect(shape(again.messages)).toEqual(shape(after.messages));
    });
  });

  it("drops reminders a refresh superseded", async () => {
    await withCapabilityHarness(async ({ storage, install }) => {
      const { session, context, setDate } = await setup(storage, (s) =>
        install(s)
      );
      await session.appendMessage(user("u1", "hello"));
      await context.build();
      await session.appendMessage(assistant("a1", "hi"));
      setDate("Tuesday");
      await session.appendMessage(user("u2", "what day?"));
      await context.build();
      await session.appendMessage(assistant("a2", "Tuesday"));

      setDate("Wednesday");
      await context.refreshSystemPrompt();
      await session.appendMessage(user("u3", "and now?"));
      const after = await context.build();
      expect(after.system).toContain("Today is Wednesday.");
      const sent = JSON.stringify(after.messages);
      expect(sent).not.toContain("Today is Tuesday.");
      expect(sent).not.toContain("These context blocks changed");
    });
  });

  it("keeps a regeneration on its branch's prompt while a refresh waits", async () => {
    await withCapabilityHarness(async ({ storage, install }) => {
      const { session, context, setDate } = await setup(storage, (s) =>
        install(s)
      );
      await session.appendMessage(user("u1", "hello"));
      const monday = await context.build();
      await session.appendMessage(assistant("a1", "hi"));
      setDate("Friday");
      await context.refreshSystemPrompt();

      // Regenerate a1: the history ends at the answered u1.
      const regenerated = await context.prepare({
        messages: [(await session.getMessage("u1"))!]
      });
      expect(regenerated.system).toBe(monday.system);
      expect(regenerated.reminder).toContain("Today is Friday.");

      // The refresh is still pending and lands on the next new turn.
      await session.appendMessage(user("u2", "again"));
      expect((await context.build()).system).toContain("Today is Friday.");
    });
  });

  it("reads only the new messages' records each turn", async () => {
    await withCapabilityHarness(async ({ storage, install }) => {
      const sessions = new Sessions();
      install(sessions);
      const session = sessions.session();
      let asked = 0;
      const counting = new Proxy(session, {
        get(target, key, receiver) {
          if (key === "internal_annotations") {
            return (kind: string, ids: readonly string[]) => {
              asked += ids.length;
              return target.internal_annotations(kind, ids);
            };
          }
          const value = Reflect.get(target, key, receiver);
          return typeof value === "function" ? value.bind(target) : value;
        }
      });
      let date = "Monday";
      const context = new Context(counting, {
        sql: storageSql(storage),
        blocks: [
          {
            label: "environment",
            provider: { get: async () => `Today is ${date}.` },
            whenChanged: "remind"
          }
        ]
      });
      const perTurn: number[] = [];
      for (let turn = 1; turn <= 12; turn++) {
        if (turn % 4 === 0) date = `day ${turn}`;
        await session.appendMessage(user(`u${turn}`, "q"));
        asked = 0;
        await context.build();
        perTurn.push(asked);
        await session.appendMessage(assistant(`a${turn}`, "a"));
      }
      // Two new messages a turn (the answer and the question), never the
      // whole transcript.
      expect(Math.max(...perTurn.slice(1))).toBeLessThanOrEqual(2);
    });
  });

  it("reads a record afresh for an id reused after a clear and refresh", async () => {
    await withCapabilityHarness(async ({ storage, install }) => {
      const { session, context, setDate } = await setup(storage, (s) =>
        install(s)
      );
      await session.appendMessage(user("u1", "hello"));
      await context.build();
      await session.appendMessage(assistant("a1", "hi"));
      setDate("Tuesday");
      await session.appendMessage(user("u2", "what day?"));
      expect(JSON.stringify((await context.build()).messages)).toContain(
        "Today is Tuesday."
      );

      // As Think clears: the transcript, then a refresh.
      await session.clearMessages();
      await context.refreshSystemPrompt();
      setDate("Wednesday");
      await session.appendMessage(user("u1", "again"));
      expect((await context.build()).system).toContain("Today is Wednesday.");
      await session.appendMessage(assistant("a1", "hi"));
      // u2 had a record delivering Tuesday before the clear.
      await session.appendMessage(user("u2", "and?"));
      const sent = JSON.stringify((await context.build()).messages);
      expect(sent).not.toContain("Today is Tuesday.");
      expect(sent).not.toContain("These context blocks changed");
    });
  });

  it("sends a recovered turn as it was first sent; a change since waits", async () => {
    await withCapabilityHarness(async ({ storage, install }) => {
      const { session, context, setDate } = await setup(storage, (s) =>
        install(s)
      );
      await session.appendMessage(user("u1", "hello"));
      await context.build();
      await session.appendMessage(assistant("a1", "hi"));
      setDate("Tuesday");
      await session.appendMessage(user("u2", "what day?"));
      const first = await context.build();
      expect(JSON.stringify(first.messages)).toContain("Today is Tuesday.");

      // The turn is cut before an answer is stored; a change and a refresh
      // arrive; recovery runs the turn again.
      setDate("Wednesday");
      const recovered = await context.prepare();
      expect(recovered.reminder).toBeNull();
      expect(await context.build()).toEqual(first);
      await context.refreshSystemPrompt();
      expect(await context.build()).toEqual(first);

      // The next new message takes the refresh.
      await session.appendMessage(assistant("a2", "Tuesday"));
      await session.appendMessage(user("u3", "now?"));
      const next = await context.build();
      expect(next.system).toContain("Today is Wednesday.");
      expect(JSON.stringify(next.messages)).not.toContain("Today is Tuesday.");
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
      expect(await context.project(history)).toEqual(
        await context.project(history)
      );
      // Reading the prompt writes nothing.
      const before = JSON.stringify(await session.getHistory());
      await context.freezeSystemPrompt();
      await context.reminder();
      expect(JSON.stringify(await session.getHistory())).toBe(before);
    });
  });
});
