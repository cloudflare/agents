import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type {
  SessionHarnessObject,
  SessionSearchHarnessObject
} from "../capabilities/sessions";
import {
  MAX_INLINE_ROW_BYTES,
  SessionSearchDisabledError,
  estimateStringTokens,
  type SessionChangeEvent,
  type SessionMessage
} from "../../sessions";
import { splitContent } from "../../sessions/chunking";

/**
 * Capability-level Sessions tests: the capability installed on a minimal
 * real Durable Object through a real Lifecycle over real SQLite, with no
 * fakes at all.
 *
 * Sessions is a MESSAGE store. A message rides in one row until its
 * serialized JSON exceeds `MAX_INLINE_ROW_BYTES`; then it is split across
 * continuation rows and reassembled on read. Nothing is truncated, and no
 * message is too large to store.
 */

/** A payload no single message row can hold. */
const OVER_BUDGET_BYTES = 2 * 1024 * 1024;

function text(id: string, body: string, role = "user"): SessionMessage {
  return { id, role, parts: [{ type: "text", text: body }] };
}

/**
 * Prose no single row can hold. Chunking tests use text, not media: an image
 * leaves the message for the attachment store before the row is ever measured,
 * so it never reaches the chunker.
 */
function bigText(id: string): SessionMessage {
  return text(id, "z".repeat(OVER_BUDGET_BYTES));
}

function imageMessage(id: string, payloadBytes: number): SessionMessage {
  const payload = btoa("p".repeat(payloadBytes));
  return {
    id,
    role: "user",
    parts: [
      { type: "text", text: "see attached" },
      {
        type: "file",
        mediaType: "image/png",
        filename: "pic.png",
        url: `data:image/png;base64,${payload}`
      }
    ]
  };
}

async function collect(
  iterator: AsyncGenerator<SessionMessage, void, undefined>
): Promise<SessionMessage[]> {
  const messages: SessionMessage[] = [];
  for await (const message of iterator) messages.push(message);
  return messages;
}

describe("Sessions capability", () => {
  it("appends a chain, follows the latest leaf, and round-trips content", async () => {
    const stub = env.SessionHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: SessionHarnessObject) => {
      const session = instance.sessions.session();
      const first = await session.appendMessage(text("m1", "hello"));
      expect(first.inserted).toBe(true);
      await session.appendMessage(text("m2", "hi there", "assistant"));
      await session.appendMessage(text("m3", "follow-up"));

      const history = await session.getHistory();
      expect(history.map((m) => m.id)).toEqual(["m1", "m2", "m3"]);
      expect(history[0].parts[0].text).toBe("hello");

      const leaf = await session.getLatestLeaf();
      expect(leaf?.id).toBe("m3");
      expect((await session.stats()).pathLength).toBe(3);

      const streamed = await collect(session.history());
      expect(streamed.map((m) => m.id)).toEqual(["m1", "m2", "m3"]);
    });
  });

  it("is idempotent on message ids and returns the existing stored row", async () => {
    const stub = env.SessionHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: SessionHarnessObject) => {
      const session = instance.sessions.session();
      await session.appendMessage(text("dup", "first"));
      const second = await session.appendMessage(text("dup", "second"));
      expect(second).toMatchObject({
        inserted: false,
        message: { id: "dup", parts: [{ type: "text", text: "first" }] }
      });
      const stored = await session.getMessage("dup");
      expect(stored?.parts[0].text).toBe("first");
      expect((await session.stats()).pathLength).toBe(1);
    });
  });

  it("branches with an explicit parent and lists siblings", async () => {
    const stub = env.SessionHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: SessionHarnessObject) => {
      const session = instance.sessions.session();
      await session.appendMessage(text("a", "root"));
      await session.appendMessage(text("b1", "answer one", "assistant"));
      await session.appendMessage(text("b2", "answer two", "assistant"), {
        parentId: "a"
      });

      const branches = await session.getBranches("a");
      expect(branches.map((m) => m.id).sort()).toEqual(["b1", "b2"]);

      // The most recent append is the active tip, even for a branch append.
      const history = await session.getHistory();
      expect(history.map((m) => m.id)).toEqual(["a", "b2"]);

      // A leaf-addressed read follows the other branch.
      const other = await session.getHistory({ leafId: "b1" });
      expect(other.map((m) => m.id)).toEqual(["a", "b1"]);
    });
  });

  it("treats null parent as root and falls back to root for foreign parents", async () => {
    const stub = env.SessionHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: SessionHarnessObject) => {
      const session = instance.sessions.session();
      await session.appendMessage(text("r1", "one"));
      await session.appendMessage(text("r2", "two"), { parentId: null });
      expect((await session.getHistory()).map((m) => m.id)).toEqual(["r2"]);

      await session.appendMessage(text("r3", "three"), {
        parentId: "not-a-real-id"
      });
      expect((await session.getHistory()).map((m) => m.id)).toEqual(["r3"]);
    });
  });

  it("updates messages in place and returns null for unknown ids", async () => {
    const stub = env.SessionHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: SessionHarnessObject) => {
      const session = instance.sessions.session();
      await session.appendMessage(text("u1", "before"));
      const updated = await session.updateMessage(text("u1", "after"));
      expect(updated?.parts[0].text).toBe("after");
      expect((await session.getMessage("u1"))?.parts[0].text).toBe("after");

      // An absent id is a miss, not a failure: no row, no throw, no event.
      expect(await session.updateMessage(text("missing", "nope"))).toBeNull();
      expect(await session.getMessage("missing")).toBeNull();
    });
  });

  it("creates FTS tables only when search indexing is enabled", async () => {
    const plain = env.SessionHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(plain, async (instance: SessionHarnessObject) => {
      await instance.sessions.session().appendMessage(text("plain", "text"));
      expect(instance.tableNames()).not.toContain("cf_agents_session_fts");
      expect(
        instance
          .tableNames()
          .some((name) => name.startsWith("cf_agents_session_fts_"))
      ).toBe(false);
    });

    const searchable = env.SessionSearchHarnessObject.getByName(
      crypto.randomUUID()
    );
    await runInDurableObject(
      searchable,
      async (instance: SessionSearchHarnessObject) => {
        await instance.sessions.session().appendMessage(text("search", "text"));
        expect(instance.tableNames()).toContain("cf_agents_session_fts");
      }
    );
  });

  it("splices children to the grandparent on mid-chain delete", async () => {
    const stub = env.SessionHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: SessionHarnessObject) => {
      const session = instance.sessions.session();
      await session.appendMessage(text("s1", "one"));
      await session.appendMessage(text("s2", "two"));
      await session.appendMessage(text("s3", "three"));

      await session.deleteMessages(["s2"]);
      // The legacy provider left a gap here, silently truncating history to
      // just the leaf. Splicing keeps the older rows reachable.
      expect((await session.getHistory()).map((m) => m.id)).toEqual([
        "s1",
        "s3"
      ]);

      await session.deleteMessages(["s3"]);
      expect((await session.getHistory()).map((m) => m.id)).toEqual(["s1"]);
      expect((await session.getLatestLeaf())?.id).toBe("s1");
    });
  });

  it("bulk-deletes spans and rewires surviving branch boundaries", async () => {
    const stub = env.SessionHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: SessionHarnessObject) => {
      const session = instance.sessions.session();
      await session.appendMessage(text("root", "root"));
      await session.appendMessage(text("left-1", "left one"));
      await session.appendMessage(text("left-2", "left two"));
      await session.appendMessage(text("left-leaf", "left leaf"));
      await session.appendMessage(text("right", "right"), {
        parentId: "root"
      });

      await session.deleteMessages(["left-1", "left-2"]);
      expect(
        (await session.getHistory({ leafId: "left-leaf" })).map(
          (message) => message.id
        )
      ).toEqual(["root", "left-leaf"]);
      expect(
        (await session.getHistory({ leafId: "right" })).map(
          (message) => message.id
        )
      ).toEqual(["root", "right"]);

      await session.deleteMessages(["root", "left-leaf"]);
      expect(
        (await session.getHistory({ leafId: "right" })).map((m) => m.id)
      ).toEqual(["right"]);
    });
  });

  it("clears messages and compactions", async () => {
    const stub = env.SessionHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: SessionHarnessObject) => {
      const session = instance.sessions.session();
      await session.appendMessage(text("c1", "one"));
      await session.appendMessage(text("c2", "two"));
      await session.addCompaction("summary", "c1", "c2");
      await session.clearMessages();
      expect(await session.getHistory()).toEqual([]);
      expect(await session.getCompactions()).toEqual([]);
      expect(await session.getLatestLeaf()).toBeNull();
    });
  });

  it("renders compaction overlays and extends them iteratively", async () => {
    const stub = env.SessionHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: SessionHarnessObject) => {
      const session = instance.sessions.session();
      for (let i = 1; i <= 4; i++) {
        await session.appendMessage(
          text(`m${i}`, `message ${i}`, i % 2 === 0 ? "assistant" : "user")
        );
      }
      await session.addCompaction("first summary", "m1", "m2");
      let history = await session.getHistory();
      expect(history).toHaveLength(3);
      expect(history[0].id).toMatch(/^compaction_/);
      expect(history[0].parts[0].text).toBe("first summary");
      expect(history.slice(1).map((m) => m.id)).toEqual(["m3", "m4"]);

      // An iterative compact() extends the existing overlay's range.
      session.onCompaction(async (messages) => ({
        fromMessageId: messages[0].id,
        toMessageId: "m3",
        summary: "extended summary"
      }));
      const result = await session.compact();
      expect(result?.fromMessageId).toBe("m1");
      history = await session.getHistory();
      expect(history).toHaveLength(2);
      expect(history[0].parts[0].text).toBe("extended summary");
      expect(history[1].id).toBe("m4");
    });
  });

  it("auto-compacts past the threshold using the O(1) stats gate", async () => {
    const stub = env.SessionHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: SessionHarnessObject) => {
      const session = instance.sessions.session();
      let compactions = 0;
      session
        .onCompaction(async (messages) => {
          compactions++;
          if (messages.length < 2) return null;
          return {
            fromMessageId: messages[0].id,
            toMessageId: messages[messages.length - 2].id,
            summary: "auto summary"
          };
        })
        .compactAfter(100);

      await session.appendMessage(text("t1", "short"));
      expect(compactions).toBe(0);

      await session.appendMessage(text("t2", "y".repeat(600), "assistant"));
      expect(compactions).toBe(1);
      const history = await session.getHistory();
      expect(history[0].parts[0].text).toBe("auto summary");
    });
  });

  it("streams history in bounded batches", async () => {
    const stub = env.SessionHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: SessionHarnessObject) => {
      const session = instance.sessions.session();
      for (let i = 0; i < 5; i++) {
        await session.appendMessage(text(`batch-${i}`, "x".repeat(100)));
      }

      const batches: SessionMessage[][] = [];
      for await (const batch of session.historyBatches({ batchSize: 2 })) {
        batches.push(batch);
      }
      expect(batches.map((batch) => batch.length)).toEqual([2, 2, 1]);

      const oneMessageBytes = new TextEncoder().encode(
        JSON.stringify(text("batch-0", "x".repeat(100)))
      ).byteLength;
      const byteBatches: SessionMessage[][] = [];
      for await (const batch of session.historyBatches({
        batchSize: 50,
        maxBatchBytes: oneMessageBytes + 10
      })) {
        byteBatches.push(batch);
      }
      expect(byteBatches).toHaveLength(5);
    });
  });

  it("budgets recent history with a floor and honest truncation", async () => {
    const stub = env.SessionHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: SessionHarnessObject) => {
      const session = instance.sessions.session();
      for (let i = 0; i < 6; i++) {
        await session.appendMessage(text(`m${i}`, "z".repeat(200)));
      }
      const stats = await session.getHistoryRowStats();
      expect(stats).toHaveLength(6);
      const perRow = stats[0].bytes;
      expect(stats[0].tokenEstimate).toBeGreaterThan(0);

      const recent = await session.getRecentHistory(perRow * 2 + 10);
      expect(recent.messages).toHaveLength(2);
      expect(recent.truncated).toBe(true);
      expect(recent.totalContentBytes).toBe(
        stats.reduce((sum, row) => sum + row.bytes, 0)
      );

      const floored = await session.getRecentHistory(1, 3);
      expect(floored.messages).toHaveLength(3);
      expect(floored.messages.map((m) => m.id)).toEqual(["m3", "m4", "m5"]);
    });
  });

  it("dispatches the change feed in order with stored messages", async () => {
    const stub = env.SessionHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: SessionHarnessObject) => {
      const events: SessionChangeEvent[] = [];
      instance.sessions.subscribe((event) => {
        events.push(event);
      });
      const session = instance.sessions.session();
      await session.appendMessage(text("e1", "one"));
      await session.appendMessage(text("e1", "dup"));
      await session.updateMessage(text("e1", "two"));
      await session.deleteMessages(["e1"]);
      await session.clearMessages();

      expect(events.map((event) => event.type)).toEqual([
        "append",
        "append",
        "update",
        "delete",
        "clear"
      ]);
      const first = events[0];
      if (first.type !== "append") throw new Error("expected append");
      expect(first.inserted).toBe(true);
      expect(first.message.id).toBe("e1");
      const second = events[1];
      if (second.type !== "append") throw new Error("expected append");
      expect(second.inserted).toBe(false);
    });
  });

  it("strips reserved metadata only from client-source writes", async () => {
    const stub = env.SessionHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: SessionHarnessObject) => {
      const session = instance.sessions.session();
      await session.appendMessage(
        {
          ...text("server-msg", "trusted"),
          metadata: { channel: "email", other: 1 }
        },
        { source: "server" }
      );
      expect((await session.getMessage("server-msg"))?.metadata).toEqual({
        channel: "email",
        other: 1
      });

      await session.appendMessage(
        {
          ...text("client-msg", "untrusted"),
          metadata: { channel: "forged", other: 2 }
        },
        { source: "client" }
      );
      expect((await session.getMessage("client-msg"))?.metadata).toEqual({
        other: 2
      });

      await session.updateMessage(
        {
          ...text("server-msg", "client rewrite"),
          metadata: { turnMetadata: { admin: true }, other: 3 }
        },
        { source: "client" }
      );
      expect((await session.getMessage("server-msg"))?.metadata).toEqual({
        other: 3
      });
    });
  });

  it("keeps O(1) stats coherent with a from-scratch recompute", async () => {
    const stub = env.SessionHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: SessionHarnessObject) => {
      const session = instance.sessions.session();
      for (let i = 0; i < 5; i++) {
        await session.appendMessage(text(`m${i}`, `body number ${i}`));
      }
      await session.updateMessage(text("m2", "a much longer rewritten body"));
      await session.addCompaction("stats summary", "m0", "m1");

      const stats = await session.stats();
      const rows = await session.getHistoryRowStats();
      const raw = rows.reduce((sum, row) => sum + row.tokenEstimate, 0);
      const covered = rows
        .filter((row) => row.id === "m0" || row.id === "m1")
        .reduce((sum, row) => sum + row.tokenEstimate, 0);
      const expected = Math.max(
        0,
        Math.ceil(raw - covered + estimateStringTokens("stats summary"))
      );
      expect(stats.tokenEstimate).toBe(expected);
      expect(stats.pathLength).toBe(5);
      expect(stats.totalContentBytes).toBe(
        rows.reduce((sum, row) => sum + row.bytes, 0)
      );
    });
  });

  it("lists sessions with derived summaries", async () => {
    const stub = env.SessionHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: SessionHarnessObject) => {
      await instance.sessions.session().appendMessage(text("d1", "default"));
      await instance.sessions.session("side").appendMessage(text("s1", "side"));
      await instance.sessions.session("side").appendMessage(text("s2", "side"));
      const sessions = await instance.sessions.listSessions();
      expect(sessions).toHaveLength(2);
      const side = sessions.find((row) => row.sessionId === "side");
      expect(side?.messageCount).toBe(2);
    });
  });

  it("forks a path, copying continuation rows with the message", async () => {
    const stub = env.SessionHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: SessionHarnessObject) => {
      const session = instance.sessions.session();
      await session.appendMessage(text("f1", "one"));
      const original = bigText("f2");
      await session.appendMessage(original);

      const fork = await session.fork({ toSessionId: "forked" });
      expect(fork.sessionId).toBe("forked");
      const forkedSession = instance.sessions.session("forked");
      const forked = await forkedSession.getHistory();
      expect(forked).toHaveLength(2);
      expect(forked.map((m) => m.id)).not.toContain("f1");
      // The copy is re-split under its own fresh id and reads back exactly.
      expect(forked[1].parts[0].text).toBe(original.parts[0].text);
      expect(instance.contentChunks("forked", forked[1].id)).toBeGreaterThan(0);
      expect(
        instance.continuationRows("forked", forked[1].id).length
      ).toBeGreaterThan(0);
    });
  });

  describe("row chunking", () => {
    it("keeps a message the row can hold in exactly one row", async () => {
      const stub = env.SessionHarnessObject.getByName(crypto.randomUUID());
      await runInDurableObject(stub, async (instance: SessionHarnessObject) => {
        const session = instance.sessions.session();
        const small = imageMessage("small", 128);
        await session.appendMessage(small);

        expect(instance.contentChunks("", "small")).toBe(0);
        expect(instance.continuationRows("", "small")).toEqual([]);
        expect((await session.getMessage("small"))?.parts[1].url).toBe(
          small.parts[1].url
        );
      });
    });

    it("splits an over-budget message and reads it back byte for byte", async () => {
      const stub = env.SessionHarnessObject.getByName(crypto.randomUUID());
      await runInDurableObject(stub, async (instance: SessionHarnessObject) => {
        const session = instance.sessions.session();
        const original = bigText("img");
        await session.appendMessage(original);

        const chunks = instance.contentChunks("", "img");
        expect(chunks).toBeGreaterThan(0);
        const rows = instance.continuationRows("", "img");
        expect(rows.map((row) => row.idx)).toEqual(
          Array.from({ length: chunks ?? 0 }, (_, index) => index + 1)
        );
        // Every slice respects the byte budget SQLite actually enforces.
        for (const row of rows) {
          expect(row.bytes).toBeLessThanOrEqual(MAX_INLINE_ROW_BYTES);
        }

        expect(await session.getMessage("img")).toEqual(original);
      });
    });

    it("round-trips a 5 MB text part", async () => {
      const stub = env.SessionHarnessObject.getByName(crypto.randomUUID());
      await runInDurableObject(stub, async (instance: SessionHarnessObject) => {
        const session = instance.sessions.session();
        const body = "t".repeat(5 * 1000 * 1000);
        const original = text("big-text", body);
        await session.appendMessage(original);

        expect(instance.contentChunks("", "big-text")).toBe(3);
        const stored = await session.getMessage("big-text");
        expect(stored?.parts[0].text).toBe(body);
        expect(stored).toEqual(original);
      });
    });

    it("round-trips a 3 MB tool output", async () => {
      const stub = env.SessionHarnessObject.getByName(crypto.randomUUID());
      await runInDurableObject(stub, async (instance: SessionHarnessObject) => {
        const session = instance.sessions.session();
        const body = "o".repeat(3 * 1000 * 1000);
        const original: SessionMessage = {
          id: "tool-out",
          role: "assistant",
          parts: [
            {
              type: "tool-inspect",
              toolCallId: "call-1",
              state: "output-available",
              input: { path: "/big" },
              output: { frames: [{ body }] }
            }
          ]
        };
        await session.appendMessage(original);

        expect(instance.contentChunks("", "tool-out")).toBeGreaterThan(0);
        expect(await session.getMessage("tool-out")).toEqual(original);
      });
    });

    it("sends a 2 MB image to the attachment store, not the chunker", async () => {
      const stub = env.SessionHarnessObject.getByName(crypto.randomUUID());
      await runInDurableObject(stub, async (instance: SessionHarnessObject) => {
        const session = instance.sessions.session();
        const original = imageMessage("png", 2 * 1000 * 1000);
        await session.appendMessage(original);

        // The two mechanisms do not overlap: media is extracted by type before
        // the row is measured, so the row never grows enough to need splitting.
        expect(instance.contentChunks("", "png")).toBe(0);
        expect(instance.continuationRows("", "png")).toEqual([]);
        expect(instance.attachmentRecords()).toHaveLength(1);

        const stored = await session.getMessage("png");
        expect(stored?.parts[1].url).toBe(original.parts[1].url);
      });
    });

    it("never splits a surrogate pair, and rejoins multi-byte content exactly", async () => {
      const stub = env.SessionHarnessObject.getByName(crypto.randomUUID());
      await runInDurableObject(stub, async (instance: SessionHarnessObject) => {
        const session = instance.sessions.session();
        // 4-byte emoji repeated past the row budget, so a boundary lands in
        // the middle of the run and would split a pair if it were naive.
        const body = `${"🙂".repeat(500_000)}é漢${"🙂".repeat(200_000)}`;
        const original = text("emoji", body);
        await session.appendMessage(original);

        expect(instance.contentChunks("", "emoji")).toBeGreaterThan(0);
        const stored = await session.getMessage("emoji");
        expect(stored?.parts[0].text).toBe(body);
        expect(stored?.parts[0].text?.length).toBe(body.length);
      });
    });

    it("deletes surplus continuations when a message shrinks", async () => {
      const stub = env.SessionHarnessObject.getByName(crypto.randomUUID());
      await runInDurableObject(stub, async (instance: SessionHarnessObject) => {
        const session = instance.sessions.session();
        await session.appendMessage(
          text("shrink", "s".repeat(5 * 1000 * 1000))
        );
        expect(instance.contentChunks("", "shrink")).toBe(3);

        await session.updateMessage(
          text("shrink", "s".repeat(2 * 1000 * 1000))
        );
        expect(instance.contentChunks("", "shrink")).toBe(1);
        expect(
          instance.continuationRows("", "shrink").map((r) => r.idx)
        ).toEqual([1]);

        await session.updateMessage(text("shrink", "tiny"));
        expect(instance.contentChunks("", "shrink")).toBe(0);
        expect(instance.continuationRows("", "shrink")).toEqual([]);
        expect((await session.getMessage("shrink"))?.parts[0].text).toBe(
          "tiny"
        );
      });
    });

    it("compares the FULL reassembled content in the no-op guard", async () => {
      const stub = env.SessionHarnessObject.getByName(crypto.randomUUID());
      await runInDurableObject(stub, async (instance: SessionHarnessObject) => {
        const session = instance.sessions.session();
        const body = "g".repeat(3 * 1000 * 1000);
        await session.appendMessage(text("guard", body));

        const events: SessionChangeEvent[] = [];
        instance.sessions.subscribe((event) => {
          events.push(event);
        });
        // Identical: nothing is written even though slice 0 alone matches
        // many other messages that share the same opening bytes.
        await session.updateMessage(text("guard", body));
        expect(events).toEqual([]);

        // A change confined to the LAST continuation still counts as changed.
        await session.updateMessage(text("guard", `${body}!`));
        expect(events.map((event) => event.type)).toEqual(["update"]);
        expect((await session.getMessage("guard"))?.parts[0].text).toBe(
          `${body}!`
        );
      });
    });

    it("removes continuations on delete and on clear", async () => {
      const stub = env.SessionHarnessObject.getByName(crypto.randomUUID());
      await runInDurableObject(stub, async (instance: SessionHarnessObject) => {
        const session = instance.sessions.session();
        await session.appendMessage(bigText("d1"));
        await session.appendMessage(bigText("d2"));
        expect(instance.continuationRowCount()).toBeGreaterThan(1);

        await session.deleteMessages(["d1"]);
        expect(instance.continuationRows("", "d1")).toEqual([]);
        expect(instance.continuationRows("", "d2").length).toBeGreaterThan(0);

        await session.clearMessages();
        expect(instance.continuationRowCount()).toBe(0);
      });
    });

    it("imports an over-budget message verbatim across continuations", async () => {
      const stub = env.SessionHarnessObject.getByName(crypto.randomUUID());
      await runInDurableObject(stub, async (instance: SessionHarnessObject) => {
        const session = instance.sessions.session();
        const original = bigText("i-media");
        await session.importMessage(original, {
          parentId: null,
          createdAt: 1000
        });

        expect(instance.contentChunks("", "i-media")).toBeGreaterThan(0);
        expect(await session.getMessage("i-media")).toEqual(original);
      });
    });

    it("counts continuation bytes in row stats and the hydration budget", async () => {
      const stub = env.SessionHarnessObject.getByName(crypto.randomUUID());
      await runInDurableObject(stub, async (instance: SessionHarnessObject) => {
        const session = instance.sessions.session();
        await session.appendMessage(text("h0", "z".repeat(200)));
        await session.appendMessage(bigText("h1"));
        await session.appendMessage(text("h2", "z".repeat(200)));

        const rows = await session.getHistoryRowStats();
        const [, bigRow, leafRow] = rows;
        // `bytes` is the whole message, not just the slice the row holds.
        expect(bigRow.bytes).toBeGreaterThan(MAX_INLINE_ROW_BYTES);
        expect((await session.stats()).totalContentBytes).toBe(
          rows.reduce((sum, row) => sum + row.bytes, 0)
        );

        // A budget that covers the big row's FULL size reaches it.
        const generous = await session.getRecentHistory(
          bigRow.bytes + leafRow.bytes + 64,
          1
        );
        expect(generous.messages.map((m) => m.id)).toEqual(["h1", "h2"]);

        // A budget sized to slice 0 alone does not, because the continuation
        // bytes are charged too (#1710).
        const tight = await session.getRecentHistory(
          MAX_INLINE_ROW_BYTES + leafRow.bytes,
          1
        );
        expect(tight.messages.map((m) => m.id)).toEqual(["h2"]);
        expect(tight.truncated).toBe(true);
      });
    });
  });

  describe("slice boundaries", () => {
    const budget = 16;

    it("rejoins to the original string exactly", () => {
      const inputs = [
        "",
        "a",
        "x".repeat(1000),
        "🙂".repeat(97),
        `${"é".repeat(31)}🙂${"漢".repeat(29)}`,
        JSON.stringify({ parts: [{ text: `🙂é漢${"z".repeat(500)}` }] })
      ];
      for (const input of inputs) {
        expect(splitContent(input, budget).join("")).toBe(input);
      }
    });

    it("keeps every slice inside the BYTE budget", () => {
      const encoder = new TextEncoder();
      for (const slice of splitContent("🙂é漢".repeat(200), budget)) {
        expect(encoder.encode(slice).byteLength).toBeLessThanOrEqual(budget);
      }
    });

    it("never leaves a lone surrogate at a boundary", () => {
      // Every boundary of a pure-emoji string is a candidate pair split.
      for (const slice of splitContent("🙂".repeat(500), budget)) {
        expect(slice.length % 2).toBe(0);
        for (let i = 0; i < slice.length; i += 2) {
          expect(slice.charCodeAt(i)).toBeGreaterThanOrEqual(0xd800);
          expect(slice.charCodeAt(i)).toBeLessThanOrEqual(0xdbff);
          expect(slice.charCodeAt(i + 1)).toBeGreaterThanOrEqual(0xdc00);
          expect(slice.charCodeAt(i + 1)).toBeLessThanOrEqual(0xdfff);
        }
      }
    });

    it("returns one slice for content that fits", () => {
      expect(splitContent("small", budget)).toEqual(["small"]);
      expect(splitContent("")).toEqual([""]);
    });
  });

  describe("search", () => {
    it("throws a stable error when indexing is disabled", async () => {
      const stub = env.SessionHarnessObject.getByName(crypto.randomUUID());
      await runInDurableObject(stub, async (instance: SessionHarnessObject) => {
        const session = instance.sessions.session();
        await session.appendMessage(text("q1", "findable body"));
        await expect(session.search("findable")).rejects.toBeInstanceOf(
          SessionSearchDisabledError
        );
      });
    });

    it("finds text when indexing is enabled", async () => {
      const stub = env.SessionSearchHarnessObject.getByName(
        crypto.randomUUID()
      );
      await runInDurableObject(
        stub,
        async (instance: SessionSearchHarnessObject) => {
          const session = instance.sessions.session();
          await session.appendMessage(text("s1", "the quick brown fox"));
          await session.appendMessage(text("s2", "unrelated content"));
          const hits = await session.search("quick brown");
          expect(hits.map((hit) => hit.id)).toEqual(["s1"]);
          // Deletes drop the FTS entry too.
          await session.deleteMessages(["s1"]);
          expect(await session.search("quick brown")).toEqual([]);
        }
      );
    });
  });

  describe("verbatim import", () => {
    it("imports historical messages with an explicit parent and timestamp", async () => {
      const stub = env.SessionHarnessObject.getByName(crypto.randomUUID());
      await runInDurableObject(stub, async (instance: SessionHarnessObject) => {
        const session = instance.sessions.session();
        await session.importMessage(text("i1", "first"), {
          parentId: null,
          createdAt: 1000
        });
        await session.importMessage(text("i2", "second"), {
          parentId: "i1",
          createdAt: 2000
        });

        expect((await session.getMessage("i1"))?.parts[0].text).toBe("first");
        expect((await session.getLatestLeaf())?.id).toBe("i2");
        expect((await session.getHistory()).map((m) => m.id)).toEqual([
          "i1",
          "i2"
        ]);
        expect(instance.messageRows("")).toEqual([
          { id: "i1", seq: 1, type: "message", parent_id: null },
          { id: "i2", seq: 2, type: "message", parent_id: "i1" }
        ]);
      });
    });

    it("is idempotent on message ids and dispatches no change event", async () => {
      const stub = env.SessionHarnessObject.getByName(crypto.randomUUID());
      await runInDurableObject(stub, async (instance: SessionHarnessObject) => {
        const events: SessionChangeEvent[] = [];
        instance.sessions.subscribe((event) => {
          events.push(event);
        });
        const session = instance.sessions.session();
        await session.importMessage(text("i1", "first"), {
          parentId: null,
          createdAt: 1000
        });
        await session.importMessage(text("i1", "duplicate root"), {
          parentId: null,
          createdAt: 3000
        });

        expect((await session.getMessage("i1"))?.parts[0].text).toBe("first");
        expect((await session.getHistory()).map((m) => m.id)).toEqual(["i1"]);
        // An import is a migration, not a turn: nothing mirrors it.
        expect(events).toEqual([]);
      });
    });

    it("stores the message verbatim", async () => {
      const stub = env.SessionHarnessObject.getByName(crypto.randomUUID());
      await runInDurableObject(stub, async (instance: SessionHarnessObject) => {
        const session = instance.sessions.session();
        const original = imageMessage("i-media", 1_200_000);
        await session.importMessage(original, {
          parentId: null,
          createdAt: 1000
        });

        expect(await session.getMessage("i-media")).toEqual(original);
      });
    });
  });

  describe("schema", () => {
    it("keys every table without a rowid and owns no context table", async () => {
      const stub = env.SessionHarnessObject.getByName(crypto.randomUUID());
      await runInDurableObject(stub, async (instance: SessionHarnessObject) => {
        await instance.sessions.session().appendMessage(text("s", "schema"));

        for (const table of [
          "cf_agents_session_messages",
          "cf_agents_session_message_chunks",
          "cf_agents_session_compactions",
          "cf_agents_session_config"
        ]) {
          expect(instance.isWithoutRowid(table)).toBe(true);
        }

        // Ordering is `ORDER BY seq`, never rowid, and rows carry a type.
        expect(instance.columnNames("cf_agents_session_messages")).toEqual([
          "session_id",
          "id",
          "seq",
          "parent_id",
          "type",
          "role",
          "content",
          "content_chunks",
          "token_estimate",
          "created_at"
        ]);
        // A continuation row carries its slice and nothing else: no media
        // type, no size, no hash. It is the message row's tail, not a record.
        expect(
          instance.columnNames("cf_agents_session_message_chunks")
        ).toEqual(["session_id", "id", "idx", "content"]);
        // Nothing survives of the attachment store.
        expect(instance.tableNames()).not.toContain(
          "cf_agents_session_attachments"
        );
        // Context blocks belong to `agents/context`, which creates the table
        // lazily. Sessions must not create it.
        expect(instance.tableNames()).not.toContain("cf_agents_context_blocks");
      });
    });

    it("keys messages by (session_id, id), so ids may repeat across sessions", async () => {
      const stub = env.SessionHarnessObject.getByName(crypto.randomUUID());
      await runInDurableObject(stub, async (instance: SessionHarnessObject) => {
        const left = instance.sessions.session("left");
        const right = instance.sessions.session("right");
        await left.appendMessage(text("shared", "left body"));
        await right.appendMessage(text("shared", "right body"));

        expect((await left.getMessage("shared"))?.parts[0].text).toBe(
          "left body"
        );
        expect((await right.getMessage("shared"))?.parts[0].text).toBe(
          "right body"
        );
        await right.updateMessage(text("shared", "right rewritten"));
        expect((await left.getMessage("shared"))?.parts[0].text).toBe(
          "left body"
        );

        await left.deleteMessages(["shared"]);
        expect(await right.getMessage("shared")).not.toBeNull();
      });
    });
  });

  describe("no-op writes", () => {
    it("dispatches no change event when an update changes nothing", async () => {
      const stub = env.SessionHarnessObject.getByName(crypto.randomUUID());
      await runInDurableObject(stub, async (instance: SessionHarnessObject) => {
        const session = instance.sessions.session();
        await session.appendMessage(text("noop", "same body"));

        const events: SessionChangeEvent[] = [];
        instance.sessions.subscribe((event) => {
          events.push(event);
        });
        const before = await session.stats();

        // The stored form is byte-identical, so nothing is written and the
        // host cache is never invalidated. `storage-ops-bench` pins the
        // billed cost of this path at zero rows.
        const result = await session.updateMessage(text("noop", "same body"));
        expect(result?.parts[0].text).toBe("same body");
        expect(events).toEqual([]);
        expect(await session.stats()).toEqual(before);
      });
    });
  });
});
