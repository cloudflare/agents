import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type {
  SessionHarnessObject,
  SessionSearchHarnessObject
} from "../capabilities/sessions";
import {
  attachmentUrl,
  parseAttachmentUrl,
  SessionMessageNotFoundError,
  SessionSearchDisabledError,
  type SessionChangeEvent,
  type SessionMessage
} from "../../sessions";
import { estimateStringTokens } from "../../experimental/memory/utils/tokens";

/**
 * Capability-level Sessions tests: the capability installed on a minimal
 * real Durable Object through a real Lifecycle over real SQLite — no fakes
 * except the in-memory attachment store behind the structural seam.
 */

function text(id: string, body: string, role = "user"): SessionMessage {
  return { id, role, parts: [{ type: "text", text: body }] };
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
      expect(await session.getPathLength()).toBe(3);

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
      expect(await session.getPathLength()).toBe(1);
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

  it("updates messages in place and throws for unknown ids", async () => {
    const stub = env.SessionHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: SessionHarnessObject) => {
      const session = instance.sessions.session();
      await session.appendMessage(text("u1", "before"));
      await session.updateMessage(text("u1", "after"));
      expect((await session.getMessage("u1"))?.parts[0].text).toBe("after");

      await expect(
        session.updateMessage(text("missing", "nope"))
      ).rejects.toBeInstanceOf(SessionMessageNotFoundError);
    });
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
      await session.appendMessage(imageMessage("f2", 4096));
      const writesBefore = instance.attachmentStore.writes;

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
      expect(instance.attachmentStore.writes).toBe(writesBefore);
    });
  });

  describe("attachments", () => {
    it("offloads oversized inline media and round-trips it on read", async () => {
      const stub = env.SessionHarnessObject.getByName(crypto.randomUUID());
      await runInDurableObject(stub, async (instance: SessionHarnessObject) => {
        const session = instance.sessions.session();
        const original = imageMessage("img", 4096);
        const result = await session.appendMessage(original);
        expect(result.attachments).toHaveLength(1);
        expect(instance.attachmentStore.writes).toBe(1);

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

    it("keeps small media inline", async () => {
      const stub = env.SessionHarnessObject.getByName(crypto.randomUUID());
      await runInDurableObject(stub, async (instance: SessionHarnessObject) => {
        const session = instance.sessions.session();
        const small = imageMessage("small", 128);
        await session.appendMessage(small);
        expect(instance.attachmentStore.writes).toBe(0);
        const stored = await session.getMessage("small", {
          reconstruct: "pointer"
        });
        expect(stored?.parts[1].url).toBe(small.parts[1].url);
      });
    });

    it("does not offload media for an idempotent duplicate", async () => {
      const stub = env.SessionHarnessObject.getByName(crypto.randomUUID());
      await runInDurableObject(stub, async (instance: SessionHarnessObject) => {
        const session = instance.sessions.session();
        await session.appendMessage(text("same-id", "stored text"));

        const duplicate = await session.appendMessage(
          imageMessage("same-id", 4096)
        );
        expect(duplicate.inserted).toBe(false);
        expect(duplicate.message.parts[0].text).toBe("stored text");
        expect(instance.attachmentStore.writes).toBe(0);
        expect(instance.attachmentStore.files.size).toBe(0);
      });
    });

    it("dedups identical payloads and reaps blobs only when unreferenced", async () => {
      const stub = env.SessionHarnessObject.getByName(crypto.randomUUID());
      await runInDurableObject(stub, async (instance: SessionHarnessObject) => {
        const session = instance.sessions.session();
        await session.appendMessage(imageMessage("dup1", 4096));
        await session.appendMessage(imageMessage("dup2", 4096));
        expect(instance.attachmentStore.writes).toBe(1);
        expect(instance.attachmentStore.files.size).toBe(1);

        await session.deleteMessages(["dup1"]);
        expect(instance.attachmentStore.files.size).toBe(1);

        await session.deleteMessages(["dup2"]);
        expect(instance.attachmentStore.files.size).toBe(0);
      });
    });

    it("replaces attachment references before reaping the old payload", async () => {
      const stub = env.SessionHarnessObject.getByName(crypto.randomUUID());
      await runInDurableObject(stub, async (instance: SessionHarnessObject) => {
        const session = instance.sessions.session();
        await session.appendMessage(imageMessage("updated", 4096));
        const [oldPath] = instance.attachmentStore.files.keys();

        const replacement = imageMessage("updated", 5000);
        replacement.role = "assistant";
        await session.updateMessage(replacement);

        expect(instance.attachmentStore.files.size).toBe(1);
        expect(instance.attachmentStore.files.has(oldPath)).toBe(false);
        expect((await session.getHistoryRowStats())[0]).toMatchObject({
          role: "assistant"
        });
        expect((await session.stats()).attachmentBytes).toBe(5000);
        expect((await session.getMessage("updated"))?.parts[1].url).toBe(
          replacement.parts[1].url
        );
      });
    });

    it("degrades missing payloads to markers instead of throwing", async () => {
      const stub = env.SessionHarnessObject.getByName(crypto.randomUUID());
      await runInDurableObject(stub, async (instance: SessionHarnessObject) => {
        const session = instance.sessions.session();
        await session.appendMessage(imageMessage("lost", 4096));
        instance.attachmentStore.files.clear();
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
        const result = await session.appendMessage(imageMessage("orig", 4096));
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

    it("counts attachment weight in stats and row estimates", async () => {
      const stub = env.SessionHarnessObject.getByName(crypto.randomUUID());
      await runInDurableObject(stub, async (instance: SessionHarnessObject) => {
        const session = instance.sessions.session();
        await session.appendMessage(imageMessage("weighted", 4096));
        const stats = await session.stats();
        expect(stats.attachmentBytes).toBe(4096);
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

  describe("sync aperture", () => {
    it("reads and writes before the lifecycle starts", async () => {
      const stub = env.SessionHarnessObject.getByName(crypto.randomUUID());
      await runInDurableObject(stub, async (instance: SessionHarnessObject) => {
        const sync = instance.sessions.__DO_NOT_USE_WILL_BREAK__sync();
        sync.ensureTables();
        expect(sync.appendMessage("", text("pre1", "pre-start"))).toBe(true);
        expect(sync.appendMessage("", text("pre1", "again"))).toBe(false);
        expect(sync.latestLeafId("")).toBe("pre1");
        expect(sync.readAll("")).toHaveLength(1);

        // The lifecycle then starts and the same rows serve the public API.
        const history = await instance.sessions.session().getHistory();
        expect(history.map((m) => m.id)).toEqual(["pre1"]);
      });
    });

    it("imports historical messages verbatim", async () => {
      const stub = env.SessionHarnessObject.getByName(crypto.randomUUID());
      await runInDurableObject(stub, async (instance: SessionHarnessObject) => {
        const sync = instance.sessions.__DO_NOT_USE_WILL_BREAK__sync();
        sync.ensureTables();
        sync.importMessage("", text("i1", "first"), {
          parentId: null,
          createdAt: 1000
        });
        sync.importMessage("", text("i2", "second"), {
          parentId: "i1",
          createdAt: 2000
        });
        sync.importMessage("", text("i1", "duplicate root"), {
          parentId: null,
          createdAt: 3000
        });
        expect(sync.latestLeafId("")).toBe("i2");
        const history = await instance.sessions.session().getHistory();
        expect(history.map((m) => m.id)).toEqual(["i1", "i2"]);
      });
    });
  });
});
