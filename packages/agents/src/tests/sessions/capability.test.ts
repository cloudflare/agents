import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type {
  SessionHarnessObject,
  SessionSearchHarnessObject
} from "../capabilities/sessions";
import {
  attachmentResponse,
  attachmentUrl,
  MAX_INLINE_ROW_BYTES,
  parseAttachmentUrl,
  SessionAttachmentTooLargeError,
  SessionMessageTooLargeError,
  SessionSearchDisabledError,
  Sessions,
  estimateStringTokens,
  type SessionChangeEvent,
  type SessionMessage
} from "../../sessions";
import { withCapabilityHarness } from "../shared/capability-harness";
import { SESSION_ATTACHMENT_CHUNK_BYTES } from "../../sessions/attachment-storage";

/**
 * Capability-level Sessions tests: the capability installed on a minimal
 * real Durable Object through a real Lifecycle over real SQLite, with no
 * fakes at all.
 *
 * Sessions is a MESSAGE store. A payload rides inline in its message row
 * until the serialized row would exceed `MAX_INLINE_ROW_BYTES`; then the
 * largest payloads are chunked out until it fits. Every test below that
 * expects a pointer therefore has to hand the row more than it can hold.
 */

/** A payload no message row can hold, so it is always chunked out. */
const OVER_BUDGET_BYTES = 2 * 1024 * 1024;

function text(id: string, body: string, role = "user"): SessionMessage {
  return { id, role, parts: [{ type: "text", text: body }] };
}

/** An image whose payload alone overflows the row budget. */
function bigImage(id: string): SessionMessage {
  return imageMessage(id, OVER_BUDGET_BYTES);
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

  it("forks a path into a new session sharing attachment blobs", async () => {
    const stub = env.SessionHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: SessionHarnessObject) => {
      const session = instance.sessions.session();
      await session.appendMessage(text("f1", "one"));
      await session.appendMessage(bigImage("f2"));
      const blobsBefore = instance.attachmentBlobCount();

      const fork = await session.fork({ toSessionId: "forked" });
      expect(fork.sessionId).toBe("forked");
      const forked = await instance.sessions.session("forked").getHistory({
        reconstruct: "pointer"
      });
      expect(forked).toHaveLength(2);
      expect(forked.map((m) => m.id)).not.toContain("f1");
      expect(forked[1].parts.some((part) => parseAttachmentUrl(part.url))).toBe(
        true
      );
      // Blobs are shared, never copied.
      expect(instance.attachmentBlobCount()).toBe(blobsBefore);
    });
  });

  describe("attachments", () => {
    it("chunks out a payload the row cannot hold and round-trips it", async () => {
      const stub = env.SessionHarnessObject.getByName(crypto.randomUUID());
      await runInDurableObject(stub, async (instance: SessionHarnessObject) => {
        const session = instance.sessions.session();
        const original = bigImage("img");
        const result = await session.appendMessage(original);
        expect(result.attachments).toHaveLength(1);
        expect(instance.attachmentBlobCount()).toBe(1);
        // The chunks live in this same Durable Object. Chunking does not
        // reclaim a byte; it only makes the row fit.
        expect(instance.attachmentChunkCount()).toBe(2);

        // Stored form carries the pointer, not the payload.
        const filePart = result.message.parts[1];
        const hash = parseAttachmentUrl(filePart.url);
        expect(hash).toMatch(/^[0-9a-f]{64}$/);
        expect(filePart.filename).toBe("pic.png");

        // Default read inlines the exact original data URL.
        const inlined = await session.getMessage("img");
        expect(inlined?.parts[1].url).toBe(original.parts[1].url);

        // Pointer mode keeps the pointer with zero store reads.
        const pointer = await session.getMessage("img", {
          reconstruct: "pointer"
        });
        expect(pointer?.parts[1].url).toBe(attachmentUrl(hash ?? ""));
      });
    });

    it("keeps a payload the row can hold inline", async () => {
      const stub = env.SessionHarnessObject.getByName(crypto.randomUUID());
      await runInDurableObject(stub, async (instance: SessionHarnessObject) => {
        const session = instance.sessions.session();
        const small = imageMessage("small", 128);
        await session.appendMessage(small);
        expect(instance.attachmentBlobCount()).toBe(0);
        const stored = await session.getMessage("small", {
          reconstruct: "pointer"
        });
        expect(stored?.parts[1].url).toBe(small.parts[1].url);
      });
    });

    it("does not offload a payload for an idempotent duplicate", async () => {
      const stub = env.SessionHarnessObject.getByName(crypto.randomUUID());
      await runInDurableObject(stub, async (instance: SessionHarnessObject) => {
        const session = instance.sessions.session();
        await session.appendMessage(text("same-id", "stored text"));

        const duplicate = await session.appendMessage(bigImage("same-id"));
        expect(duplicate.inserted).toBe(false);
        expect(duplicate.message.parts[0].text).toBe("stored text");
        expect(instance.attachmentBlobCount()).toBe(0);
        expect(instance.attachmentChunkCount()).toBe(0);
      });
    });

    it("dedups identical payloads and reaps blobs only when unreferenced", async () => {
      const stub = env.SessionHarnessObject.getByName(crypto.randomUUID());
      await runInDurableObject(stub, async (instance: SessionHarnessObject) => {
        const session = instance.sessions.session();
        await session.appendMessage(bigImage("dup1"));
        await session.appendMessage(bigImage("dup2"));
        expect(instance.attachmentBlobCount()).toBe(1);
        expect(instance.attachmentChunkCount()).toBe(2);

        await session.deleteMessages(["dup1"]);
        expect(instance.attachmentBlobCount()).toBe(1);

        await session.deleteMessages(["dup2"]);
        expect(instance.attachmentBlobCount()).toBe(0);
        expect(instance.attachmentChunkCount()).toBe(0);
      });
    });

    it("replaces attachment references before reaping the old payload", async () => {
      const stub = env.SessionHarnessObject.getByName(crypto.randomUUID());
      await runInDurableObject(stub, async (instance: SessionHarnessObject) => {
        const session = instance.sessions.session();
        await session.appendMessage(bigImage("updated"));
        const [oldHash] = instance.attachmentHashes();

        const replacement = imageMessage("updated", OVER_BUDGET_BYTES + 904);
        replacement.role = "assistant";
        await session.updateMessage(replacement);

        expect(instance.attachmentBlobCount()).toBe(1);
        expect(instance.attachmentHashes()).not.toContain(oldHash);
        expect((await session.getHistoryRowStats())[0]).toMatchObject({
          role: "assistant"
        });
        expect((await session.stats()).attachmentBytes).toBe(
          OVER_BUDGET_BYTES + 904
        );
        expect((await session.getMessage("updated"))?.parts[1].url).toBe(
          replacement.parts[1].url
        );
      });
    });

    it("degrades missing payloads to markers instead of throwing", async () => {
      const stub = env.SessionHarnessObject.getByName(crypto.randomUUID());
      await runInDurableObject(stub, async (instance: SessionHarnessObject) => {
        const session = instance.sessions.session();
        await session.appendMessage(bigImage("lost"));
        instance.deleteAttachmentChunks();
        const read = await session.getMessage("lost");
        expect(read?.parts[1].type).toBe("text");
        expect(read?.parts[1].text).toContain("no longer available");
      });
    });

    it("rejects forged client pointers", async () => {
      const stub = env.SessionHarnessObject.getByName(crypto.randomUUID());
      await runInDurableObject(stub, async (instance: SessionHarnessObject) => {
        const session = instance.sessions.session();
        const forged: SessionMessage = {
          id: "forged",
          role: "user",
          parts: [
            {
              type: "file",
              mediaType: "image/png",
              url: attachmentUrl("ab".repeat(32))
            }
          ]
        };
        await session.appendMessage(forged, { source: "client" });
        const stored = await session.getMessage("forged", {
          reconstruct: "pointer"
        });
        expect(stored?.parts[0].type).toBe("text");
        expect(stored?.parts[0].text).toContain("no longer available");
      });
    });

    it("accepts legitimate client echoes of stored pointers", async () => {
      const stub = env.SessionHarnessObject.getByName(crypto.randomUUID());
      await runInDurableObject(stub, async (instance: SessionHarnessObject) => {
        const session = instance.sessions.session();
        const result = await session.appendMessage(bigImage("orig"));
        const echoed: SessionMessage = {
          id: "echo",
          role: "user",
          parts: [result.message.parts[1]]
        };
        await session.appendMessage(echoed, { source: "client" });
        const stored = await session.getMessage("echo", {
          reconstruct: "pointer"
        });
        expect(parseAttachmentUrl(stored?.parts[0].url)).toBeTruthy();
      });
    });

    it("streams payloads through the capability attachments surface", async () => {
      const stub = env.SessionHarnessObject.getByName(crypto.randomUUID());
      await runInDurableObject(stub, async (instance: SessionHarnessObject) => {
        const payload = new TextEncoder().encode("streamed attachment body");
        const { part, attachment } = await instance.sessions.attachments.put(
          new ReadableStream({
            start(controller) {
              controller.enqueue(payload);
              controller.close();
            }
          }),
          { mediaType: "application/pdf", filename: "doc.pdf" }
        );
        expect(parseAttachmentUrl(part.url)).toBe(attachment.hash);

        const stream = await instance.sessions.attachments.open(part.url ?? "");
        const read = new Uint8Array(await new Response(stream).arrayBuffer());
        expect(new TextDecoder().decode(read)).toBe("streamed attachment body");
      });
    });

    it("keeps a standalone put durable until the caller deletes it", async () => {
      await withCapabilityHarness(async ({ install, storage }) => {
        const first = install(new Sessions());
        await first.lifecycle.start();
        const stored = await first.capability.attachments.put("standalone", {
          mediaType: "text/plain",
          filename: "standalone.txt"
        });
        expect(
          storage.sql
            .exec("SELECT COUNT(*) AS count FROM cf_agents_session_attachments")
            .one().count
        ).toBe(0);

        // A cold capability instance must recover metadata from the whole-file
        // row rather than an in-memory cache or a message-reference row.
        const second = install(new Sessions());
        await second.lifecycle.start();
        await expect(
          second.capability.attachments.get(stored.part.url ?? "")
        ).resolves.toMatchObject({
          hash: stored.attachment.hash,
          mediaType: "text/plain",
          filename: "standalone.txt",
          bytes: 10
        });
        expect(
          new TextDecoder().decode(
            new Uint8Array(
              await new Response(
                await second.capability.attachments.open(stored.part.url ?? "")
              ).arrayBuffer()
            )
          )
        ).toBe("standalone");
        await expect(
          second.capability.attachments.delete(stored.part.url ?? "")
        ).resolves.toBe(true);
        await expect(
          second.capability.attachments.get(stored.part.url ?? "")
        ).resolves.toBeNull();
      });
    });

    it("cleans only newly created blobs when an update finds no row", async () => {
      await withCapabilityHarness(async ({ install, storage }) => {
        const { capability, lifecycle } = install(new Sessions());
        await lifecycle.start();
        const existing = "e".repeat(OVER_BUDGET_BYTES);
        const existingUrl = `data:text/plain;base64,${btoa(existing)}`;
        const standalone = await capability.attachments.put(
          new TextEncoder().encode(existing),
          { mediaType: "text/plain" }
        );

        await capability.session().updateMessage({
          id: "missing-existing",
          role: "user",
          parts: [{ type: "file", mediaType: "text/plain", url: existingUrl }]
        });
        expect(
          storage.sql
            .exec(
              "SELECT COUNT(*) AS count FROM cf_agents_session_attachment_blobs"
            )
            .one().count
        ).toBe(1);
        await expect(
          capability.attachments.open(standalone.part.url ?? "")
        ).resolves.toBeInstanceOf(ReadableStream);

        const freshUrl = `data:text/plain;base64,${btoa(
          "f".repeat(OVER_BUDGET_BYTES)
        )}`;
        await capability.session().updateMessage({
          id: "missing-fresh",
          role: "user",
          parts: [{ type: "file", mediaType: "text/plain", url: freshUrl }]
        });
        expect(
          storage.sql
            .exec(
              "SELECT COUNT(*) AS count FROM cf_agents_session_attachment_blobs"
            )
            .one().count
        ).toBe(1);
      });
    });

    it("validates a declared stream length against the bytes that arrive", async () => {
      await withCapabilityHarness(async ({ install, storage }) => {
        const { capability, lifecycle } = install(new Sessions());
        await lifecycle.start();
        const payload = new Uint8Array(4096);
        payload[4095] = 7;
        const halves = (): ReadableStream<Uint8Array> =>
          new ReadableStream({
            start(controller) {
              controller.enqueue(payload.subarray(0, 2048));
              controller.enqueue(payload.subarray(2048));
              controller.close();
            }
          });
        const { part } = await capability.attachments.put(halves(), {
          mediaType: "application/pdf",
          filename: "direct.pdf",
          bytes: payload.byteLength
        });
        const opened = new Uint8Array(
          await new Response(
            await capability.attachments.open(part.url ?? "")
          ).arrayBuffer()
        );
        expect(opened[4095]).toBe(7);

        // A declared length that the stream does not honour is a caller bug,
        // and the half-written chunks are cleaned up rather than committed.
        const chunksBefore = storage.sql
          .exec(
            "SELECT COUNT(*) AS count FROM cf_agents_session_attachment_chunks"
          )
          .one().count;
        await expect(
          capability.attachments.put(halves(), {
            mediaType: "application/pdf",
            bytes: 9999
          })
        ).rejects.toThrow(/did not match declared length/);
        expect(
          storage.sql
            .exec(
              "SELECT COUNT(*) AS count FROM cf_agents_session_attachment_chunks"
            )
            .one().count
        ).toBe(chunksBefore);
      });
    });

    it("splits SQLite attachment streams at the 1.5 MiB window", async () => {
      const stub = env.SessionHarnessObject.getByName(crypto.randomUUID());
      await runInDurableObject(stub, async (instance: SessionHarnessObject) => {
        const bytes = new Uint8Array(SESSION_ATTACHMENT_CHUNK_BYTES + 1);
        bytes[bytes.length - 1] = 42;
        const { part } = await instance.sessions.attachments.put(bytes, {
          mediaType: "application/pdf",
          filename: "two-windows.pdf"
        });

        expect(instance.attachmentBlobCount()).toBe(1);
        expect(instance.attachmentChunkCount()).toBe(2);
        const opened = new Uint8Array(
          await new Response(
            await instance.sessions.attachments.open(part.url ?? "")
          ).arrayBuffer()
        );
        expect(opened.byteLength).toBe(bytes.byteLength);
        expect(opened[opened.length - 1]).toBe(42);
      });
    });

    it("reconstructs base64 exactly across storage-window carries", async () => {
      const stub = env.SessionHarnessObject.getByName(crypto.randomUUID());
      await runInDurableObject(stub, async (instance: SessionHarnessObject) => {
        const session = instance.sessions.session();
        for (const extra of [1, 2]) {
          const payload = "a".repeat(SESSION_ATTACHMENT_CHUNK_BYTES + extra);
          const original = `data:application/pdf;base64,${btoa(payload)}`;
          await session.appendMessage({
            id: `carry-${extra}`,
            role: "user",
            parts: [
              {
                type: "file",
                mediaType: "application/pdf",
                filename: `carry-${extra}.pdf`,
                url: original
              }
            ]
          });
          expect(
            (await session.getMessage(`carry-${extra}`))?.parts[0].url
          ).toBe(original);
        }
      });
    });

    it("rejects attachments above the configured memory ceiling", async () => {
      await withCapabilityHarness(async ({ install, storage }) => {
        // The default ceiling is 32 MiB; this pins the policy, not the size.
        const { capability, lifecycle } = install(
          new Sessions({ attachments: { maxAttachmentBytes: 4096 } })
        );
        await lifecycle.start();

        const error = await capability.attachments
          .put(new Uint8Array(4097), {
            mediaType: "application/octet-stream"
          })
          .catch((e) => e);
        expect(error).toBeInstanceOf(SessionAttachmentTooLargeError);
        expect(error.maxBytes).toBe(4096);
        for (const table of [
          "cf_agents_session_attachment_blobs",
          "cf_agents_session_attachment_chunks"
        ]) {
          expect(
            storage.sql.exec(`SELECT COUNT(*) AS count FROM ${table}`).one()
              .count
          ).toBe(0);
        }
      });
    });

    it("serves attachment responses without buffering the payload", async () => {
      const stub = env.SessionHarnessObject.getByName(crypto.randomUUID());
      await runInDurableObject(stub, async (instance: SessionHarnessObject) => {
        const appended = await instance.sessions
          .session()
          .appendMessage(bigImage("served"));
        const pointer = appended.message.parts[1].url ?? "";

        const response = await attachmentResponse(instance.sessions, pointer);
        expect(response.status).toBe(200);
        expect(response.headers.get("content-type")).toBe("image/png");
        expect(response.headers.get("content-length")).toBe(
          String(OVER_BUDGET_BYTES)
        );
        expect(new Uint8Array(await response.arrayBuffer())).toHaveLength(
          OVER_BUDGET_BYTES
        );

        const missing = await attachmentResponse(
          instance.sessions,
          "ef".repeat(32)
        );
        expect(missing.status).toBe(404);
      });
    });

    it("counts attachment weight in stats and row estimates", async () => {
      const stub = env.SessionHarnessObject.getByName(crypto.randomUUID());
      await runInDurableObject(stub, async (instance: SessionHarnessObject) => {
        const session = instance.sessions.session();
        await session.appendMessage(bigImage("weighted"));
        const stats = await session.stats();
        expect(stats.attachmentBytes).toBe(OVER_BUDGET_BYTES);
        // Images charge a flat estimate instead of the legacy zero.
        const rows = await session.getHistoryRowStats();
        expect(rows[0].tokenEstimate).toBeGreaterThanOrEqual(1600);
      });
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

    it("stores the message verbatim, without offloading payloads", async () => {
      const stub = env.SessionHarnessObject.getByName(crypto.randomUUID());
      await runInDurableObject(stub, async (instance: SessionHarnessObject) => {
        const session = instance.sessions.session();
        // Over the row budget, but still inside SQLite's own row ceiling:
        // an import writes the row verbatim, with no chance to offload.
        const original = imageMessage("i-media", 1_200_000);
        await session.importMessage(original, {
          parentId: null,
          createdAt: 1000
        });

        expect(instance.attachmentBlobCount()).toBe(0);
        const stored = await session.getMessage("i-media", {
          reconstruct: "pointer"
        });
        expect(stored?.parts[1].url).toBe(original.parts[1].url);
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
          "cf_agents_session_compactions",
          "cf_agents_session_attachments",
          "cf_agents_session_config",
          "cf_agents_session_attachment_blobs",
          "cf_agents_session_attachment_chunks"
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
          "token_estimate",
          "created_at"
        ]);
        // Attachment references are derived: no path, media type, size, or
        // filename is duplicated onto the reference row.
        expect(instance.columnNames("cf_agents_session_attachments")).toEqual([
          "session_id",
          "message_id",
          "hash"
        ]);
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

  describe("lossless offload", () => {
    it("offloads an oversized text part and reconstructs it byte for byte", async () => {
      const stub = env.SessionHarnessObject.getByName(crypto.randomUUID());
      await runInDurableObject(stub, async (instance: SessionHarnessObject) => {
        const session = instance.sessions.session();
        const body = "t".repeat(2 * 1024 * 1024);
        const original = text("big-text", body);
        const result = await session.appendMessage(original);

        expect(result.attachments).toHaveLength(1);
        const stored = await session.getMessage("big-text", {
          reconstruct: "pointer"
        });
        // Pointer mode never touches the store: the pointer stays as written.
        expect(stored?.parts[0].text).toBe(
          attachmentUrl(result.attachments[0].hash)
        );
        expect(stored?.parts[0].type).toBe("text");

        const inlined = await session.getMessage("big-text");
        expect(inlined?.parts[0].text).toBe(body);
        expect(inlined).toEqual(original);
      });
    });

    it("offloads an oversized reasoning part", async () => {
      const stub = env.SessionHarnessObject.getByName(crypto.randomUUID());
      await runInDurableObject(stub, async (instance: SessionHarnessObject) => {
        const session = instance.sessions.session();
        const original: SessionMessage = {
          id: "big-reasoning",
          role: "assistant",
          parts: [{ type: "reasoning", text: "r".repeat(2 * 1024 * 1024) }]
        };
        await session.appendMessage(original);

        const stored = await session.getMessage("big-reasoning", {
          reconstruct: "pointer"
        });
        expect(parseAttachmentUrl(stored?.parts[0].text)).toBeTruthy();
        expect(await session.getMessage("big-reasoning")).toEqual(original);
      });
    });

    it("offloads a nested tool-output string without truncating it", async () => {
      const stub = env.SessionHarnessObject.getByName(crypto.randomUUID());
      await runInDurableObject(stub, async (instance: SessionHarnessObject) => {
        const session = instance.sessions.session();
        const dump = "d".repeat(3 * 1024 * 1024);
        const original: SessionMessage = {
          id: "big-tool",
          role: "assistant",
          parts: [
            {
              type: "tool-read",
              toolName: "read",
              toolCallId: "call-1",
              state: "output-available",
              input: { path: "/big.txt" },
              output: {
                path: "/big.txt",
                totalLines: 3,
                frames: [{ body: dump }, { body: "small" }]
              }
            }
          ]
        };
        await session.appendMessage(original);

        const stored = await session.getMessage("big-tool", {
          reconstruct: "pointer"
        });
        const output = stored?.parts[0].output as {
          path: string;
          totalLines: number;
          frames: Array<{ body: string }>;
        };
        // The container shape survives; only the oversized leaf moves.
        expect(output.path).toBe("/big.txt");
        expect(output.totalLines).toBe(3);
        expect(output.frames[1].body).toBe("small");
        expect(parseAttachmentUrl(output.frames[0].body)).toBeTruthy();

        const inlined = await session.getMessage("big-tool");
        const restored = inlined?.parts[0].output as typeof output;
        expect(restored.frames[0].body).toBe(dump);
        expect(restored.frames[0].body.length).toBe(dump.length);
        expect(inlined).toEqual(original);
      });
    });

    it("rejects a row that cannot fit even after offload", async () => {
      const stub = env.SessionHarnessObject.getByName(crypto.randomUUID());
      await runInDurableObject(stub, async (instance: SessionHarnessObject) => {
        const session = instance.sessions.session();
        // Metadata is not an offloadable payload: there is nothing to move
        // out, and Sessions refuses to truncate to make the row fit.
        const oversized: SessionMessage = {
          ...text("too-large", "hello"),
          metadata: { blob: "m".repeat(2 * 1024 * 1024) }
        };

        const error = await session.appendMessage(oversized).catch((e) => e);
        expect(error).toBeInstanceOf(SessionMessageTooLargeError);
        expect(error.messageId).toBe("too-large");
        expect(error.maxBytes).toBe(MAX_INLINE_ROW_BYTES);
        expect(error.bytes).toBeGreaterThan(MAX_INLINE_ROW_BYTES);
        expect(await session.getMessage("too-large")).toBeNull();
        expect(instance.attachmentBlobCount()).toBe(0);
      });
    });

    it("round-trips every offloaded media type", async () => {
      const stub = env.SessionHarnessObject.getByName(crypto.randomUUID());
      await runInDurableObject(stub, async (instance: SessionHarnessObject) => {
        const session = instance.sessions.session();
        const mediaTypes = [
          ["application/pdf", "doc.pdf"],
          ["image/webp", "shot.webp"],
          ["image/gif", "loop.gif"],
          ["image/jpeg", "photo.jpg"],
          ["text/markdown", "notes.md"],
          ["text/csv", "rows.csv"]
        ] as const;

        for (const [mediaType, filename] of mediaTypes) {
          const url = `data:${mediaType};base64,${btoa(
            `${mediaType}:${"b".repeat(OVER_BUDGET_BYTES)}`
          )}`;
          const original: SessionMessage = {
            id: `media-${filename}`,
            role: "user",
            parts: [{ type: "file", mediaType, filename, url }]
          };
          const result = await session.appendMessage(original);

          expect(result.attachments[0]).toMatchObject({
            mediaType,
            filename
          });
          const stored = await session.getMessage(original.id, {
            reconstruct: "pointer"
          });
          expect(parseAttachmentUrl(stored?.parts[0].url)).toBeTruthy();
          expect(stored?.parts[0].mediaType).toBe(mediaType);
          expect(await session.getMessage(original.id)).toEqual(original);
        }
        expect(instance.attachmentBlobCount()).toBe(mediaTypes.length);
      });
    });

    it("fills whole chunk windows exactly at the boundary", async () => {
      const stub = env.SessionHarnessObject.getByName(crypto.randomUUID());
      await runInDurableObject(stub, async (instance: SessionHarnessObject) => {
        const sizes = [
          SESSION_ATTACHMENT_CHUNK_BYTES - 1,
          SESSION_ATTACHMENT_CHUNK_BYTES,
          SESSION_ATTACHMENT_CHUNK_BYTES + 1
        ];
        const chunkRows: number[] = [];
        let previous = 0;
        for (const size of sizes) {
          const bytes = new Uint8Array(size);
          bytes[size - 1] = size % 251;
          const { part } = await instance.sessions.attachments.put(bytes, {
            mediaType: "application/octet-stream"
          });
          const total = instance.attachmentChunkCount();
          chunkRows.push(total - previous);
          previous = total;

          const opened = new Uint8Array(
            await new Response(
              await instance.sessions.attachments.open(part.url ?? "")
            ).arrayBuffer()
          );
          expect(opened.byteLength).toBe(size);
          expect(opened[size - 1]).toBe(size % 251);
        }
        expect(chunkRows).toEqual([1, 1, 2]);
      });
    });
  });

  describe("one extraction rule", () => {
    /** A 200 KB image: large for a row, but the row can still hold it. */
    function mediumImage(id: string): SessionMessage {
      return imageMessage(id, 200 * 1024);
    }

    it("keeps a 200 KB image inline, because the row can hold it", async () => {
      const stub = env.SessionHarnessObject.getByName(crypto.randomUUID());
      await runInDurableObject(stub, async (instance: SessionHarnessObject) => {
        const session = instance.sessions.session();
        const original = mediumImage("inline-image");
        const result = await session.appendMessage(original);

        // Moving these bytes into chunk rows would not free one byte of the
        // 10 GB: the chunks live in this same Durable Object. Inline is the
        // resting place, and it costs one billed row instead of four.
        expect(result.attachments).toEqual([]);
        expect(instance.attachmentBlobCount()).toBe(0);
        expect(instance.attachmentChunkCount()).toBe(0);
        expect(
          await session.getMessage("inline-image", { reconstruct: "pointer" })
        ).toEqual(original);
        expect(await session.getMessage("inline-image")).toEqual(original);
      });
    });

    it("extracts a 3 MB text part, because the row cannot hold it", async () => {
      const stub = env.SessionHarnessObject.getByName(crypto.randomUUID());
      await runInDurableObject(stub, async (instance: SessionHarnessObject) => {
        const session = instance.sessions.session();
        const original = text("over-budget", "t".repeat(3 * 1024 * 1024));
        const result = await session.appendMessage(original);

        // Nothing about the payload's type earns this: only the row budget.
        expect(result.attachments).toHaveLength(1);
        expect(instance.attachmentChunkCount()).toBeGreaterThan(0);
        const rows = await session.getHistoryRowStats();
        expect(rows[0].bytes).toBeLessThanOrEqual(MAX_INLINE_ROW_BYTES);
        expect(await session.getMessage("over-budget")).toEqual(original);
      });
    });

    it("reconstructs both byte for byte", async () => {
      const stub = env.SessionHarnessObject.getByName(crypto.randomUUID());
      await runInDurableObject(stub, async (instance: SessionHarnessObject) => {
        const session = instance.sessions.session();
        const inline = mediumImage("mixed-inline");
        const oversized = text("mixed-text", "t".repeat(3 * 1024 * 1024));

        for (const message of [inline, oversized]) {
          await session.appendMessage(message);
        }

        const history = await session.getHistory();
        expect(history).toEqual([inline, oversized]);
      });
    });
  });

  describe("hydration budget", () => {
    it("charges attachment bytes against the recent-history budget", async () => {
      const stub = env.SessionHarnessObject.getByName(crypto.randomUUID());
      await runInDurableObject(stub, async (instance: SessionHarnessObject) => {
        const session = instance.sessions.session();
        await session.appendMessage(text("h0", "z".repeat(200)));
        await session.appendMessage(bigImage("h1"));
        await session.appendMessage(text("h2", "z".repeat(200)));

        const rows = await session.getHistoryRowStats();
        const [, attachmentRow, leafRow] = rows;
        expect(attachmentRow.attachmentBytes).toBe(OVER_BUDGET_BYTES);
        // A budget that fits both stored rows with room to spare.
        const budget = attachmentRow.bytes + leafRow.bytes + 64;

        // Pointer mode reads no payload, so only stored bytes count.
        const pointer = await session.getRecentHistory(budget, 1, {
          reconstruct: "pointer"
        });
        expect(pointer.messages.map((m) => m.id)).toEqual(["h1", "h2"]);

        // Inlining re-inflates 2 MiB into memory, so the same budget no
        // longer covers that row (#1710).
        const inline = await session.getRecentHistory(budget);
        expect(inline.messages.map((m) => m.id)).toEqual(["h2"]);
        expect(inline.truncated).toBe(true);
        expect(inline.totalContentBytes).toBe(
          rows.reduce((sum, row) => sum + row.bytes, 0)
        );
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
