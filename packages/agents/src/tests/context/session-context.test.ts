import { describe, expect, it } from "vitest";
import {
  AgentSearchProvider,
  Context,
  type ContextConfig,
  type SqlProvider,
  type WritableContextProvider
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

/** The model writes a block with set_context in an answer, as a turn does. */
async function modelWrites(
  context: Context,
  session: Session,
  answerId: string,
  label: string,
  content: string,
  action: "replace" | "append" = "replace"
): Promise<void> {
  const tools = await context.tools();
  const setContext = tools.set_context as unknown as {
    execute(input: unknown, options: unknown): Promise<unknown>;
  };
  const input = { label, content, action };
  const output = await setContext.execute(input, {
    toolCallId: `call-${answerId}`,
    messages: []
  });
  await session.appendMessage({
    id: answerId,
    role: "assistant",
    parts: [
      {
        type: "tool-set_context",
        toolCallId: `call-${answerId}`,
        state: "output-available",
        input,
        output
      }
    ]
  } as SessionMessage);
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

  it("sends a block written from code once, after the next user message", async () => {
    await withCapabilityHarness(async ({ storage, install }) => {
      const { session, context } = await setup(storage, (s) => install(s), [
        { label: "notes", maxTokens: 100 }
      ]);
      await session.appendMessage(user("u1", "hello"));
      const first = await context.build();
      await session.appendMessage(assistant("a1", "hi"));
      await context.setBlock("notes", "The user moved to Lisbon.");
      await session.appendMessage(user("u2", "where am I?"));
      const second = await context.build();
      expect(second.system).toBe(first.system);
      expect(texts(second.messages.at(-1))[1]).toContain("moved to Lisbon");
      await session.appendMessage(assistant("a2", "Lisbon"));
      await session.appendMessage(user("u3", "thanks"));
      const third = await context.build();
      expect(
        JSON.stringify(third.messages).split("moved to Lisbon").length - 1
      ).toBe(1);
    });
  });

  it("does not send back a block the model wrote itself", async () => {
    await withCapabilityHarness(async ({ storage, install }) => {
      const { session, context } = await setup(storage, (s) => install(s), [
        { label: "todo", whenChanged: "remind" },
        { label: "notes" }
      ]);
      await session.appendMessage(user("u1", "plan it"));
      const first = await context.build();
      await modelWrites(context, session, "a1", "todo", "1. draft");
      await session.appendMessage(user("u2", "next"));
      const second = await context.build();
      expect(second.system).toBe(first.system);
      // Only the tool call itself holds it.
      expect(JSON.stringify(second.messages).split("1. draft").length - 1).toBe(
        1
      );
      expect(context.getBlock("todo")?.content).toBe("1. draft");
      // Still not, once a later change is recorded past the tool call.
      await session.appendMessage(assistant("a2", "ok"));
      await context.setBlock("notes", "x");
      await session.appendMessage(user("u3", "more"));
      await context.build();
      await session.appendMessage(assistant("a3", "ok"));
      await session.appendMessage(user("u4", "again"));
      const fourth = await context.build();
      expect(JSON.stringify(fourth.messages).split("1. draft").length - 1).toBe(
        1
      );
    });
  });

  it("sends a block the model wrote on another branch to a branch without the write", async () => {
    await withCapabilityHarness(async ({ storage, install }) => {
      const { session, context } = await setup(storage, (s) => install(s), [
        { label: "todo", whenChanged: "remind" }
      ]);
      await session.appendMessage(user("u1", "plan it"));
      await context.build();
      await modelWrites(context, session, "a1", "todo", "1. draft");
      // Regenerate a1: a sibling answer without the tool call.
      await session.appendMessage(assistant("b1", "no plan"), {
        parentId: "u1"
      });
      await session.appendMessage(user("u2", "next"));
      const sent = JSON.stringify((await context.build()).messages);
      expect(sent).not.toContain("tool-set_context");
      expect(sent).toContain("1. draft");
    });
  });

  it("sends a provider's change to a block the model wrote, once it differs", async () => {
    await withCapabilityHarness(async ({ storage, install }) => {
      let todo = "";
      const { session, context, setDate } = await setup(
        storage,
        (s) => install(s),
        [
          {
            label: "todo",
            whenChanged: "remind",
            provider: {
              get: async () => todo,
              set: async (content: string) => {
                todo = content;
              }
            }
          }
        ]
      );
      await session.appendMessage(user("u1", "plan it"));
      await context.build();
      await modelWrites(context, session, "a1", "todo", "draft");
      // The app changes the plan behind the provider, not through Context,
      // and another block changes on the same turn.
      todo = "approved";
      setDate("Tuesday");
      await session.appendMessage(user("u2", "next"));
      const last = (await context.build()).messages.at(-1);
      expect(texts(last)[1]).toContain("approved");
      expect(texts(last)[1]).toContain("Today is Tuesday.");
    });
  });

  it("does not send back a block the model overwrote after code wrote it", async () => {
    await withCapabilityHarness(async ({ storage, install }) => {
      const { session, context } = await setup(storage, (s) => install(s), [
        { label: "notes" }
      ]);
      await session.appendMessage(user("u1", "hello"));
      const first = await context.build();
      await context.setBlock("notes", "from code");
      await modelWrites(context, session, "a1", "notes", "from the model");
      await session.appendMessage(user("u2", "next"));
      const second = await context.build();
      expect(second.system).toBe(first.system);
      expect(texts(second.messages.at(-1))).toHaveLength(1);
    });
  });

  it("sends code's change to a block the model appended to", async () => {
    await withCapabilityHarness(async ({ storage, install }) => {
      const { session, context } = await setup(storage, (s) => install(s), [
        { label: "notes" }
      ]);
      await context.setBlock("notes", "Deploy to staging");
      await session.appendMessage(user("u1", "hello"));
      await context.build();
      await modelWrites(
        context,
        session,
        "a1",
        "notes",
        "Run smoke tests",
        "append"
      );
      await context.setBlock("notes", "Deploy to production\nRun smoke tests");
      await session.appendMessage(user("u2", "next"));
      const last = (await context.build()).messages.at(-1);
      expect(texts(last)[1]).toContain("Deploy to production");
    });
  });

  it("keeps the model's successful write when a later call fails", async () => {
    await withCapabilityHarness(async ({ storage, install }) => {
      const { session, context } = await setup(storage, (s) => install(s), [
        { label: "todo", whenChanged: "remind" }
      ]);
      await session.appendMessage(user("u1", "plan it"));
      await context.build();
      await modelWrites(context, session, "a1", "todo", "1. draft");
      await session.appendMessage({
        id: "a2",
        role: "assistant",
        parts: [
          {
            type: "tool-set_context",
            toolCallId: "call-a2",
            state: "output-available",
            input: {
              label: "todo",
              content: "far too long",
              action: "replace"
            },
            output: "Error: over the block's token limit"
          }
        ]
      } as SessionMessage);
      await session.appendMessage(user("u2", "next"));
      const sent = JSON.stringify((await context.build()).messages);
      expect(sent.split("1. draft").length - 1).toBe(1);
    });
  });

  it("sends a block code set back to the value the prompt shows", async () => {
    await withCapabilityHarness(async ({ storage, install }) => {
      const { session, context } = await setup(storage, (s) => install(s), [
        { label: "notes" }
      ]);
      await session.appendMessage(user("u1", "hello"));
      await context.build();
      await modelWrites(context, session, "a1", "notes", "likes tea");
      await context.setBlock("notes", "");
      await session.appendMessage(user("u2", "next"));
      const last = (await context.build()).messages.at(-1);
      expect(texts(last)[1] ?? "").toContain("These context blocks changed");
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

  it("sends a retry as the first attempt was; a change since waits", async () => {
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
      // arrive; recovery sends the turn again.
      setDate("Wednesday");
      const again = await context.prepare({ retry: true });
      expect(again).toEqual({ system: first.system, reminder: null });
      expect(await context.project(await session.getHistory())).toEqual(
        first.messages
      );
      await context.refreshSystemPrompt();
      expect((await context.prepare({ retry: true })).system).toBe(
        first.system
      );

      // The next new message takes the refresh.
      await session.appendMessage(assistant("a2", "Tuesday"));
      await session.appendMessage(user("u3", "now?"));
      const next = await context.build();
      expect(next.system).toContain("Today is Wednesday.");
      expect(JSON.stringify(next.messages)).not.toContain("Today is Tuesday.");
    });
  });

  it("sends a retry as the first attempt was when that attempt recorded nothing", async () => {
    await withCapabilityHarness(async ({ storage, install }) => {
      const { session, context, setDate } = await setup(storage, (s) =>
        install(s)
      );
      await session.appendMessage(user("u1", "hello"));
      await context.build();
      await session.appendMessage(assistant("a1", "hi"));
      // Nothing changed, so the first attempt of u2 records nothing.
      await session.appendMessage(user("u2", "again"));
      const first = await context.build();
      expect(
        (await session.internal_annotations("context", ["u2"])).has("u2")
      ).toBe(false);

      setDate("Tuesday");
      const again = await context.prepare({ retry: true });
      expect(again.reminder).toBeNull();
      expect(await context.project(await session.getHistory())).toEqual(
        first.messages
      );

      await session.appendMessage(assistant("a2", "ok"));
      await session.appendMessage(user("u3", "and?"));
      const next = await context.build();
      expect(JSON.stringify(next.messages.at(-1))).toContain(
        "Today is Tuesday."
      );
    });
  });

  it("gives a regenerated answer from before the upgrade the release's prompt, after a refresh", async () => {
    await withCapabilityHarness(async ({ storage, install }) => {
      const sessions = new Sessions();
      install(sessions);
      const session = sessions.session();
      let date = "Monday";
      const released = "Released prompt: today is Monday.";
      const make = () =>
        new Context(session, {
          sql: storageSql(storage),
          blocks: [
            {
              label: "environment",
              provider: { get: async () => `Today is ${date}.` },
              whenChanged: "remind"
            }
          ],
          // As Think's `_system_prompt` row.
          promptStore: { get: async () => released }
        });
      const context = make();
      // Turns the release answered: no record on them.
      await session.appendMessage(user("u1", "hello"));
      await session.appendMessage(assistant("a1", "hi"));
      await session.appendMessage(user("u2", "again"));
      expect((await context.build()).system).toBe(released);
      await session.appendMessage(assistant("a2", "ok"));
      date = "Tuesday";
      await context.refreshSystemPrompt();
      await session.appendMessage(user("u3", "now?"));
      expect((await context.build()).system).toContain("Today is Tuesday.");

      // Regenerate a1: its history ends at u1, before any record.
      const u1 = (await session.getMessage("u1"))!;
      expect((await context.prepare({ messages: [u1] })).system).toBe(released);
      // And after an eviction (a new instance).
      expect((await make().prepare({ messages: [u1] })).system).toBe(released);
    });
  });

  it("never brings a frozen prompt back after the transcript is cleared", async () => {
    await withCapabilityHarness(async ({ storage, install }) => {
      const sessions = new Sessions();
      install(sessions);
      const session = sessions.session();
      const released = "Released prompt.";
      let writes = 0;
      // A writable store, as `withCachedPrompt()` takes: never written.
      const store: WritableContextProvider = {
        get: async () => released,
        set: async () => {
          writes++;
        }
      };
      const make = () =>
        new Context(session, {
          sql: storageSql(storage),
          blocks: [],
          promptStore: store
        });
      const context = make();
      await session.appendMessage(user("u1", "hello"));
      await session.appendMessage(assistant("a1", "hi"));
      await session.appendMessage(user("u2", "again"));
      expect((await context.build()).system).toBe(released);

      // As Think clears: the transcript, then a refresh.
      await session.clearMessages();
      await context.refreshSystemPrompt();
      await session.appendMessage(user("n1", "new chat"));
      expect((await context.build()).system).not.toContain(released);
      await session.appendMessage(assistant("m1", "hi"));
      await session.appendMessage(user("n2", "more"));
      expect((await context.build()).system).not.toContain(released);
      // After an eviction too.
      expect((await make().build()).system).not.toContain(released);
      expect(writes).toBe(0);
    });
  });

  it("keeps the frozen prompt for a first turn from before the upgrade that is retried", async () => {
    await withCapabilityHarness(async ({ storage, install }) => {
      const sessions = new Sessions();
      install(sessions);
      const session = sessions.session();
      const released = "Released prompt.";
      const context = new Context(session, {
        sql: storageSql(storage),
        blocks: [{ label: "soul", provider: { get: async () => "Be kind." } }],
        promptStore: { get: async () => released }
      });
      // The release sent u1 and was cut before an answer was stored.
      await session.appendMessage(user("u1", "hello"));
      expect((await context.prepare({ retry: true })).system).toBe(released);
      // The answer, then a new turn: still the release's prompt.
      await session.appendMessage(assistant("a1", "hi"));
      await session.appendMessage(user("u2", "again"));
      expect((await context.build()).system).toBe(released);
    });
  });

  it("never brings a frozen prompt back to a retry after a clear without a refresh", async () => {
    await withCapabilityHarness(async ({ storage, install }) => {
      const sessions = new Sessions();
      install(sessions);
      const session = sessions.session();
      const released = "Released prompt.";
      const make = () =>
        new Context(session, {
          sql: storageSql(storage),
          blocks: [
            { label: "soul", provider: { get: async () => "Be kind." } }
          ],
          promptStore: { get: async () => released }
        });
      const context = make();
      await session.appendMessage(user("u1", "hello"));
      await session.appendMessage(assistant("a1", "hi"));
      await session.appendMessage(user("u2", "again"));
      expect((await context.build()).system).toBe(released);

      // A session-level clear: no refresh. A new turn is
      // accepted, then recovered before it was prepared, in this instance
      // and in a new one.
      await session.clearMessages();
      await session.appendMessage(user("n1", "new chat"));
      expect((await make().prepare({ retry: true })).system).not.toBe(released);
      expect((await context.prepare({ retry: true })).system).not.toBe(
        released
      );
      await session.appendMessage(assistant("m1", "hi"));
      await session.appendMessage(user("n2", "more"));
      expect((await context.build()).system).not.toBe(released);
    });
  });

  it("gives a regenerated answer from before the upgrade the release's prompt while a refresh waits", async () => {
    await withCapabilityHarness(async ({ storage, install }) => {
      const sessions = new Sessions();
      install(sessions);
      const session = sessions.session();
      const released = "Released prompt.";
      const context = new Context(session, {
        sql: storageSql(storage),
        blocks: [{ label: "soul", provider: { get: async () => "Be kind." } }],
        promptStore: { get: async () => released }
      });
      await session.appendMessage(user("u1", "hello"));
      await session.appendMessage(assistant("a1", "hi"));
      // A refresh is asked for before any turn after the upgrade.
      await context.refreshSystemPrompt();
      const u1 = (await session.getMessage("u1"))!;
      expect((await context.prepare({ messages: [u1] })).system).toBe(released);
      // The next new turn takes the refresh.
      await session.appendMessage(user("u2", "again"));
      expect((await context.build()).system).toContain("Be kind.");
    });
  });

  it("keeps the frozen prompt for turns from before the upgrade when a later message is deleted", async () => {
    await withCapabilityHarness(async ({ storage, install }) => {
      const sessions = new Sessions();
      install(sessions);
      const session = sessions.session();
      const released = "Released prompt.";
      const make = () =>
        new Context(session, {
          sql: storageSql(storage),
          blocks: [
            { label: "soul", provider: { get: async () => "Be kind." } }
          ],
          promptStore: { get: async () => released }
        });
      await session.appendMessage(user("u1", "hello"));
      await session.appendMessage(assistant("a1", "hi"));
      await session.appendMessage(user("u2", "follow-up"));
      expect((await make().build()).system).toBe(released);
      // Delete only the follow-up, which holds the session's first record.
      await session.deleteMessages(["u2"]);
      const u1 = (await session.getMessage("u1"))!;
      expect((await make().prepare({ messages: [u1] })).system).toBe(released);
    });
  });

  it("never brings a frozen prompt back after a clear that came before any record", async () => {
    await withCapabilityHarness(async ({ storage, install }) => {
      const sessions = new Sessions();
      install(sessions);
      const session = sessions.session();
      const released = "Released prompt: memory empty.";
      let memory = "empty";
      const make = () =>
        new Context(session, {
          sql: storageSql(storage),
          blocks: [
            {
              label: "memory",
              provider: { get: async () => `Memory: ${memory}.` }
            }
          ],
          promptStore: { get: async () => released }
        });
      // Turns the release answered; Context has not been asked anything yet.
      await session.appendMessage(user("u1", "hello"));
      await session.appendMessage(assistant("a1", "hi"));
      memory = "likes tea";
      await session.clearMessages();

      // A new turn, cut before it prepared and recovered, then the next one.
      await session.appendMessage(user("n1", "new chat"));
      const recovered = await make().prepare({ retry: true });
      expect(recovered.system).not.toContain(released);
      expect(recovered.system).toContain("likes tea");
      await session.appendMessage(assistant("m1", "hi"));
      await session.appendMessage(user("n2", "more"));
      expect((await make().build()).system).toContain("likes tea");
    });
  });

  it("never fails a turn on a frozen prompt store that throws or is empty", async () => {
    for (const store of [
      {
        get: async (): Promise<string | null> => {
          throw new Error("store down");
        }
      },
      {
        // Throws before returning a promise.
        get: (): Promise<string | null> => {
          throw new Error("store down");
        }
      },
      { get: async (): Promise<string | null> => null },
      { get: async () => "" }
    ]) {
      await withCapabilityHarness(async ({ storage, install }) => {
        const sessions = new Sessions();
        install(sessions);
        const session = sessions.session();
        const context = new Context(session, {
          sql: storageSql(storage),
          blocks: [
            { label: "soul", provider: { get: async () => "Be kind." } }
          ],
          promptStore: store
        });
        await session.appendMessage(user("u1", "hello"));
        const built = await context.build();
        expect(built.system).toContain("Be kind.");
      });
    }
  });

  it("records what a turn was sent while the frozen prompt store was down", async () => {
    await withCapabilityHarness(async ({ storage, install }) => {
      const sessions = new Sessions();
      install(sessions);
      const session = sessions.session();
      const released = "Released prompt.";
      let down = true;
      const make = () =>
        new Context(session, {
          sql: storageSql(storage),
          blocks: [
            { label: "soul", provider: { get: async () => "Be kind." } }
          ],
          promptStore: {
            get: async () => {
              if (down) throw new Error("store down");
              return released;
            }
          }
        });
      const context = make();
      // A turn the release answered, then the first turn after the upgrade
      // while the store is down: sent the blocks, and that is recorded.
      await session.appendMessage(user("u1", "hello"));
      await session.appendMessage(assistant("a1", "hi"));
      await session.appendMessage(user("u2", "again"));
      const outage = await context.build();
      expect(outage.system).toContain("Be kind.");
      await session.appendMessage(assistant("a2", "ok"));
      down = false;
      // The store is back. The next turn extends what was sent.
      await session.appendMessage(user("u3", "more"));
      expect((await context.build()).system).toBe(outage.system);
      // Regenerating the outage reply sends what it was sent; regenerating
      // the release's reply sends the release's prompt, in a new instance too.
      const u1 = (await session.getMessage("u1"))!;
      const u2 = (await session.getMessage("u2"))!;
      for (const ctx of [context, make()]) {
        expect(
          (
            await ctx.prepare({
              messages: [u1, (await session.getMessage("a1"))!, u2]
            })
          ).system
        ).toBe(outage.system);
        expect((await ctx.prepare({ messages: [u1] })).system).toBe(released);
      }
    });
  });

  it("records the empty prompt a turn with no blocks was sent while the store was down", async () => {
    await withCapabilityHarness(async ({ storage, install }) => {
      const sessions = new Sessions();
      install(sessions);
      const session = sessions.session();
      let down = true;
      const make = () =>
        new Context(session, {
          sql: storageSql(storage),
          blocks: [],
          promptStore: {
            get: async () => {
              if (down) throw new Error("store down");
              return "Released prompt.";
            }
          }
        });
      await session.appendMessage(user("u1", "hello"));
      await session.appendMessage(assistant("a1", "hi"));
      await session.appendMessage(user("u2", "again"));
      expect((await make().build()).system).toBe("");
      await session.appendMessage(assistant("a2", "ok"));
      down = false;
      const history = await session.getHistory();
      const throughU2 = history.slice(
        0,
        history.findIndex((m) => m.id === "u2") + 1
      );
      expect((await make().prepare({ messages: throughU2 })).system).toBe("");
      // The release's own turn still gets the release's prompt.
      expect(
        (await make().prepare({ messages: history.slice(0, 1) })).system
      ).toBe("Released prompt.");
    });
  });

  it("tells the model once, in place, when the tools it is sent change", async () => {
    await withCapabilityHarness(async ({ storage, install }) => {
      const { session, context } = await setup(storage, (s) => install(s));
      const a = { name: "search", hash: "1" };
      const b = { name: "fetch", hash: "1" };
      await session.appendMessage(user("u1", "hello"));
      const first = await context.prepare({ tools: [a, b] });
      expect(first.reminder).toBeNull();
      await session.appendMessage(assistant("a1", "hi"));

      // Same tools: nothing.
      await session.appendMessage(user("u2", "again"));
      await context.prepare({ tools: [a, b] });
      expect(
        texts((await context.project(await session.getHistory())).at(-1))
      ).toHaveLength(1);
      await session.appendMessage(assistant("a2", "ok"));

      // fetch gone, search changed, write added.
      await session.appendMessage(user("u3", "now"));
      const third = await context.prepare({
        tools: [
          { name: "search", hash: "2" },
          { name: "write", hash: "1" }
        ]
      });
      expect(third.system).toBe(first.system);
      expect(third.reminder).toBeNull();
      const sent = await context.project(await session.getHistory());
      const notice = texts(sent.at(-1)).at(-1) ?? "";
      expect(notice).toContain("Added: write.");
      expect(notice).toContain("Removed: fetch. Do not call them");
      expect(notice).toContain("Changed: search.");
      await session.appendMessage(assistant("a3", "ok"));

      // Next turn: the notice stays on u3 and is not sent again.
      await session.appendMessage(user("u4", "next"));
      await context.prepare({
        tools: [
          { name: "search", hash: "2" },
          { name: "write", hash: "1" }
        ]
      });
      const later = JSON.stringify(
        await context.project(await session.getHistory())
      );
      expect(later.split("The tools you can call changed").length - 1).toBe(1);
      expect(
        texts((await context.project(await session.getHistory())).at(-1))
      ).toHaveLength(1);
    });
  });

  it("sends a tool change on a continuation once, and records nothing for it", async () => {
    await withCapabilityHarness(async ({ storage, install }) => {
      const { session, context } = await setup(storage, (s) => install(s));
      await session.appendMessage(user("u1", "hello"));
      await context.prepare({ tools: [{ name: "search", hash: "1" }] });
      await session.appendMessage(assistant("a1", "partial"));
      const continued = await context.prepare({ tools: [] });
      expect(continued.reminder).toContain("Removed: search.");
      // A retry sends nothing new.
      await session.appendMessage(user("u2", "again"));
      expect(
        (await context.prepare({ tools: [], retry: true })).reminder
      ).toBeNull();
    });
  });

  it("starts comparing tools on a session recorded before the fingerprint, and across a compaction", async () => {
    await withCapabilityHarness(async ({ storage, install }) => {
      const { session, context } = await setup(storage, (s) => install(s));
      // A record written without tools, as before this change.
      await session.appendMessage(user("u1", "hello"));
      await context.prepare();
      await session.appendMessage(assistant("a1", "hi"));
      // The first turn with tools records them and says nothing.
      await session.appendMessage(user("u2", "again"));
      expect(
        (await context.prepare({ tools: [{ name: "search", hash: "1" }] }))
          .reminder
      ).toBeNull();
      expect(
        JSON.stringify(await context.project(await session.getHistory()))
      ).not.toContain("The tools you can call changed");
      await session.appendMessage(assistant("a2", "ok"));
      await session.appendMessage(user("u3", "more"));
      await session.appendMessage(assistant("a3", "ok"));
      // A summary hides the record that holds the fingerprint.
      await session.addCompaction("earlier turns", "u1", "a3");
      await session.appendMessage(user("u4", "next"));
      await context.prepare({ tools: [] });
      const last = texts(
        (await context.project(await session.getHistory())).at(-1)
      );
      expect(last.at(-1)).toContain("Removed: search.");
    });
  });

  it("tells the model about changed tools in a session with no blocks", async () => {
    await withCapabilityHarness(async ({ storage, install }) => {
      const sessions = new Sessions();
      install(sessions);
      const session = sessions.session();
      const context = new Context(session, {
        sql: storageSql(storage),
        blocks: []
      });
      await session.appendMessage(user("u1", "hello"));
      await context.prepare({ tools: [{ name: "search", hash: "1" }] });
      await session.appendMessage(assistant("a1", "hi"));
      await session.appendMessage(user("u2", "again"));
      const second = await context.prepare({ tools: [] });
      expect(second.system).toBe("");
      const last = texts(
        (await context.project(await session.getHistory())).at(-1)
      );
      expect(last.at(-1)).toContain("Removed: search.");
    });
  });

  it("does not send the model its own write back after a turn that only changed tools", async () => {
    await withCapabilityHarness(async ({ storage, install }) => {
      const { session, context } = await setup(storage, (s) => install(s), [
        { label: "todo", whenChanged: "remind" }
      ]);
      await session.appendMessage(user("u1", "plan it"));
      await context.prepare({ tools: [{ name: "search", hash: "1" }] });
      await modelWrites(context, session, "a1", "todo", "1. draft");
      // Only the tools change on this turn.
      await session.appendMessage(user("u2", "next"));
      await context.prepare({ tools: [{ name: "search", hash: "2" }] });
      await session.appendMessage(assistant("a2", "ok"));
      await session.appendMessage(user("u3", "more"));
      await context.prepare({ tools: [{ name: "search", hash: "2" }] });
      const sent = JSON.stringify(
        await context.project(await session.getHistory())
      );
      // Only the tool call itself holds it.
      expect(sent.split("1. draft").length - 1).toBe(1);
    });
  });

  it("keeps each call's tools to its own record when two calls overlap", async () => {
    await withCapabilityHarness(async ({ storage, install }) => {
      // A remind block whose read can be held at a gate.
      let hold = false;
      let waiting = false;
      let release = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const { session, context } = await setup(storage, (s) => install(s), [
        { label: "notes" },
        {
          label: "clock",
          whenChanged: "remind",
          provider: {
            get: async () => {
              if (hold) {
                waiting = true;
                await gate;
              }
              return "noon";
            }
          }
        }
      ]);
      await session.appendMessage(user("u1", "hello"));
      await context.prepare();
      await session.appendMessage(assistant("a1", "hi"));
      await context.setBlock("notes", "likes tea");
      await session.appendMessage(user("u2", "again"));
      const u1 = (await session.getMessage("u1"))!;
      // A regeneration of a1 that passes tools stops inside prepare...
      hold = true;
      const regeneration = context.prepare({
        messages: [u1],
        tools: [{ name: "search", hash: "1" }]
      });
      while (!waiting) await new Promise((resolve) => setTimeout(resolve, 1));
      hold = false;
      // ...while the new turn u2 records the code write, passing no tools.
      await context.prepare();
      release();
      await regeneration;
      const record = JSON.parse(
        (await session.internal_annotations("context", ["u2"])).get("u2") ??
          "{}"
      ) as { tools?: unknown; changes?: unknown };
      expect(record.changes).toBeDefined();
      expect(record.tools).toBeUndefined();
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
