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
  parseAttachmentUrl,
  SessionAttachmentTooLargeError,
  SessionMessageNotFoundError,
  SessionSearchDisabledError,
  Sessions,
  estimateStringTokens,
  type SessionAttachmentBucket,
  type SessionChangeEvent,
  type SessionMessage,
  type SkillProvider
} from "../../sessions";
import { withCapabilityHarness } from "../shared/capability-harness";
import { SESSION_ATTACHMENT_CHUNK_BYTES } from "../../sessions/attachment-storage";

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

class FakeAttachmentBucket implements SessionAttachmentBucket {
  readonly objects = new Map<string, Uint8Array>();
  puts = 0;
  gets = 0;
  deletes = 0;

  async get(key: string): Promise<{ body: ReadableStream<Uint8Array> } | null> {
    this.gets++;
    const stored = this.objects.get(key);
    if (!stored) return null;
    const bytes = new Uint8Array(stored);
    return {
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(bytes);
          controller.close();
        }
      })
    };
  }

  async put(key: string, value: ReadableStream<Uint8Array>): Promise<void> {
    this.puts++;
    this.objects.set(
      key,
      new Uint8Array(await new Response(value).arrayBuffer())
    );
  }

  async delete(key: string | string[]): Promise<void> {
    this.deletes++;
    for (const item of typeof key === "string" ? [key] : key) {
      this.objects.delete(item);
    }
  }
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

  it("can preserve legacy no-op semantics for missing updates", async () => {
    await withCapabilityHarness(async ({ install }) => {
      const { capability, lifecycle } = install(
        new Sessions({ missingUpdate: "ignore" })
      );
      await lifecycle.start();

      await expect(
        capability.session().updateMessage(text("missing", "ignored"))
      ).resolves.toMatchObject({ id: "missing" });
      await expect(
        capability.session().getMessage("missing")
      ).resolves.toBeNull();
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
      await session.appendMessage(imageMessage("f2", 4096));
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
    it("offloads oversized inline media and round-trips it on read", async () => {
      const stub = env.SessionHarnessObject.getByName(crypto.randomUUID());
      await runInDurableObject(stub, async (instance: SessionHarnessObject) => {
        const session = instance.sessions.session();
        const original = imageMessage("img", 4096);
        const result = await session.appendMessage(original);
        expect(result.attachments).toHaveLength(1);
        expect(instance.attachmentBlobCount()).toBe(1);
        expect(instance.attachmentChunkCount()).toBe(1);

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
        expect(instance.attachmentBlobCount()).toBe(0);
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
        expect(instance.attachmentBlobCount()).toBe(0);
        expect(instance.attachmentChunkCount()).toBe(0);
      });
    });

    it("dedups identical payloads and reaps blobs only when unreferenced", async () => {
      const stub = env.SessionHarnessObject.getByName(crypto.randomUUID());
      await runInDurableObject(stub, async (instance: SessionHarnessObject) => {
        const session = instance.sessions.session();
        await session.appendMessage(imageMessage("dup1", 4096));
        await session.appendMessage(imageMessage("dup2", 4096));
        expect(instance.attachmentBlobCount()).toBe(1);
        expect(instance.attachmentChunkCount()).toBe(1);

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
        await session.appendMessage(imageMessage("updated", 4096));
        const [oldHash] = instance.attachmentHashes();

        const replacement = imageMessage("updated", 5000);
        replacement.role = "assistant";
        await session.updateMessage(replacement);

        expect(instance.attachmentBlobCount()).toBe(1);
        expect(instance.attachmentHashes()).not.toContain(oldHash);
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

    it("cleans only newly created blobs when an ignored update does not persist", async () => {
      await withCapabilityHarness(async ({ install, storage }) => {
        const { capability, lifecycle } = install(
          new Sessions({
            attachments: { inlineThresholdBytes: 1 },
            missingUpdate: "ignore"
          })
        );
        await lifecycle.start();
        const existingUrl = `data:text/plain;base64,${btoa("existing")}`;
        const standalone = await capability.attachments.put(
          new TextEncoder().encode("existing"),
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

        const freshUrl = `data:text/plain;base64,${btoa("fresh")}`;
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

    it("uses one R2 object for large payloads and skips duplicate puts", async () => {
      await withCapabilityHarness(async ({ install, storage }) => {
        const bucket = new FakeAttachmentBucket();
        const { capability, lifecycle } = install(
          new Sessions({
            attachments: {
              r2: bucket,
              inlineThresholdBytes: 1,
              r2ThresholdBytes: 1024
            }
          })
        );
        await lifecycle.start();
        const session = capability.session();
        const original = imageMessage("r2-first", 4096);
        await session.appendMessage(original);
        await session.appendMessage(imageMessage("r2-duplicate", 4096));

        expect(bucket.puts).toBe(1);
        expect(bucket.objects.size).toBe(1);
        expect(
          storage.sql
            .exec(
              "SELECT COUNT(*) AS count FROM cf_agents_session_attachment_chunks"
            )
            .one().count
        ).toBe(0);
        expect((await session.getMessage("r2-first"))?.parts[1].url).toBe(
          original.parts[1].url
        );
        expect(bucket.gets).toBe(1);

        await session.deleteMessages(["r2-first"]);
        expect(bucket.deletes).toBe(0);
        await session.deleteMessages(["r2-duplicate"]);
        expect(bucket.deletes).toBe(1);
        expect(bucket.objects.size).toBe(0);
      });
    });

    it("streams a declared-length upload directly to R2", async () => {
      await withCapabilityHarness(async ({ install, storage }) => {
        const bucket = new FakeAttachmentBucket();
        const { capability, lifecycle } = install(
          new Sessions({
            attachments: { r2: bucket, r2ThresholdBytes: 1024 }
          })
        );
        await lifecycle.start();
        const payload = new Uint8Array(4096);
        payload[4095] = 7;
        const { part } = await capability.attachments.put(
          new ReadableStream({
            start(controller) {
              controller.enqueue(payload.subarray(0, 2048));
              controller.enqueue(payload.subarray(2048));
              controller.close();
            }
          }),
          {
            mediaType: "application/pdf",
            filename: "direct.pdf",
            bytes: payload.byteLength
          }
        );

        expect(bucket.puts).toBe(1);
        expect(
          storage.sql
            .exec(
              "SELECT COUNT(*) AS count FROM cf_agents_session_attachment_chunks"
            )
            .one().count
        ).toBe(0);
        const opened = new Uint8Array(
          await new Response(
            await capability.attachments.open(part.url ?? "")
          ).arrayBuffer()
        );
        expect(opened[4095]).toBe(7);
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

    it("retains threshold-independent media hints when policy is lowered", async () => {
      await withCapabilityHarness(async ({ install }) => {
        let threshold = 4096;
        const { capability, lifecycle } = install(
          new Sessions({
            attachments: {
              inlineThresholdBytes: Number.MAX_SAFE_INTEGER,
              evictionThresholdBytes: () => threshold,
              keepRecentMessages: 2
            }
          })
        );
        await lifecycle.start();
        const session = capability.session();
        const original = imageMessage("threshold-media", 2048);
        await session.appendMessage(original);
        await session.appendMessage(text("threshold-recent-1", "one"));
        await session.appendMessage(text("threshold-recent-2", "two"));

        expect(await session.evictAgedMedia()).toMatchObject({
          messages: 0,
          backlogRemains: false
        });
        threshold = 1024;
        expect(await session.evictAgedMedia()).toMatchObject({
          messages: 1,
          backlogRemains: false
        });
        expect(
          parseAttachmentUrl(
            (
              await session.getMessage("threshold-media", {
                reconstruct: "pointer"
              })
            )?.parts[1].url
          )
        ).toBeTruthy();
      });
    });

    it("losslessly externalizes file parts after they age out", async () => {
      const stub = env.SessionHarnessObject.getByName(crypto.randomUUID());
      await runInDurableObject(stub, async (instance: SessionHarnessObject) => {
        const original = imageMessage("aged-image", 4096);
        const sync = instance.sessions.__DO_NOT_USE_WILL_BREAK__sync();
        sync.ensureTables();
        sync.appendMessage("", original);

        const session = instance.sessions.session();
        await session.appendMessage(text("recent-1", "one"));
        await session.appendMessage(text("recent-2", "two"));
        const result = await session.evictAgedMedia();

        expect(result).toMatchObject({
          messages: 1,
          parts: 1,
          backlogRemains: false
        });
        const pointer = await session.getMessage("aged-image", {
          reconstruct: "pointer"
        });
        expect(parseAttachmentUrl(pointer?.parts[1].url)).toBeTruthy();
        expect((await session.getMessage("aged-image"))?.parts[1].url).toBe(
          original.parts[1].url
        );
        expect(instance.attachmentBlobCount()).toBe(1);
      });
    });

    it("externalizes aged tool strings without changing output shape", async () => {
      const stub = env.SessionHarnessObject.getByName(crypto.randomUUID());
      await runInDurableObject(stub, async (instance: SessionHarnessObject) => {
        const sync = instance.sessions.__DO_NOT_USE_WILL_BREAK__sync();
        sync.ensureTables();
        sync.appendMessage("", {
          id: "aged-tool",
          role: "assistant",
          parts: [
            {
              type: "tool-screenshot",
              toolName: "screenshot",
              toolCallId: "shot-1",
              state: "output-available",
              input: { page: 1 },
              output: {
                note: "kept",
                frames: [{ image: "z".repeat(4096) }]
              }
            }
          ]
        });
        const session = instance.sessions.session();
        await session.appendMessage(text("recent-tool-1", "one"));
        await session.appendMessage(text("recent-tool-2", "two"));

        const result = await session.evictAgedMedia();
        expect(result).toMatchObject({ messages: 1, parts: 1 });
        const stored = await session.getMessage("aged-tool", {
          reconstruct: "pointer"
        });
        const output = stored?.parts[0].output as
          | { note: string; frames: Array<{ image: string }> }
          | undefined;
        expect(output?.note).toBe("kept");
        expect(output?.frames[0].image).toContain("attachment:sha256:");
        expect((await session.stats()).attachmentBytes).toBe(4096);
      });
    });

    it("uses compare-and-swap so maintenance cannot overwrite a live rewrite", async () => {
      const stub = env.SessionHarnessObject.getByName(crypto.randomUUID());
      await runInDurableObject(stub, async (instance: SessionHarnessObject) => {
        const sync = instance.sessions.__DO_NOT_USE_WILL_BREAK__sync();
        sync.ensureTables();
        sync.appendMessage("", {
          id: "racy",
          role: "assistant",
          parts: [
            {
              type: "tool-dump",
              toolName: "dump",
              state: "output-available",
              output: "x".repeat(4096)
            }
          ]
        });
        const session = instance.sessions.session();
        await session.appendMessage(text("race-recent-1", "one"));
        await session.appendMessage(text("race-recent-2", "two"));

        instance.onAttachmentStored = () => {
          instance.onAttachmentStored = undefined;
          sync.updateMessage("", text("racy", "live rewrite"));
        };
        const result = await session.evictAgedMedia();

        expect(result?.messages).toBe(0);
        expect((await session.getMessage("racy"))?.parts[0].text).toBe(
          "live rewrite"
        );
        expect(instance.attachmentBlobCount()).toBe(0);
      });
    });

    it("marks large non-media rows checked so bounded passes make progress", async () => {
      const stub = env.SessionHarnessObject.getByName(crypto.randomUUID());
      await runInDurableObject(stub, async (instance: SessionHarnessObject) => {
        const sync = instance.sessions.__DO_NOT_USE_WILL_BREAK__sync();
        sync.ensureTables();
        sync.appendMessage("", text("large-text", "plain ".repeat(1000)));
        const session = instance.sessions.session();
        await session.appendMessage(text("plain-recent-1", "one"));
        await session.appendMessage(text("plain-recent-2", "two"));

        expect(await session.evictAgedMedia()).toMatchObject({
          messages: 0,
          backlogRemains: false
        });
        expect(await session.evictAgedMedia()).toMatchObject({
          messages: 0,
          backlogRemains: false
        });
      });
    });

    it("rejects attachments above the configured memory ceiling", async () => {
      const stub = env.SessionHarnessObject.getByName(crypto.randomUUID());
      await runInDurableObject(stub, async (instance: SessionHarnessObject) => {
        await expect(
          instance.sessions.attachments.put(
            new Uint8Array(8 * 1024 * 1024 + 1),
            { mediaType: "application/octet-stream" }
          )
        ).rejects.toBeInstanceOf(SessionAttachmentTooLargeError);
        expect(instance.attachmentBlobCount()).toBe(0);
        expect(instance.attachmentChunkCount()).toBe(0);
      });
    });

    it("serves attachment responses without buffering the payload", async () => {
      const stub = env.SessionHarnessObject.getByName(crypto.randomUUID());
      await runInDurableObject(stub, async (instance: SessionHarnessObject) => {
        const appended = await instance.sessions
          .session()
          .appendMessage(imageMessage("served", 4096));
        const pointer = appended.message.parts[1].url ?? "";

        const response = await attachmentResponse(instance.sessions, pointer);
        expect(response.status).toBe(200);
        expect(response.headers.get("content-type")).toBe("image/png");
        expect(response.headers.get("content-length")).toBe("4096");
        expect(new Uint8Array(await response.arrayBuffer())).toHaveLength(4096);

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
        await session.appendMessage(imageMessage("weighted", 4096));
        const stats = await session.stats();
        expect(stats.attachmentBytes).toBe(4096);
        // Images charge a flat estimate instead of the legacy zero.
        const rows = await session.getHistoryRowStats();
        expect(rows[0].tokenEstimate).toBeGreaterThanOrEqual(1600);
      });
    });
  });

  describe("context and skills", () => {
    it("auto-wires durable context and a namespaced frozen prompt", async () => {
      const stub = env.SessionHarnessObject.getByName(crypto.randomUUID());
      await runInDurableObject(stub, async (instance: SessionHarnessObject) => {
        const first = instance.sessions
          .session("first")
          .withContext("memory", { maxTokens: 100 })
          .withCachedPrompt();
        const second = instance.sessions
          .session("second")
          .withContext("memory", { maxTokens: 100 })
          .withCachedPrompt();

        await first.replaceContextBlock("memory", "first fact");
        await second.replaceContextBlock("memory", "second fact");
        expect(await first.freezeSystemPrompt()).toContain("first fact");
        expect(await second.freezeSystemPrompt()).toContain("second fact");

        await first.replaceContextBlock("memory", "changed after freeze");
        expect(await first.freezeSystemPrompt()).toContain("first fact");
        expect(await first.refreshSystemPrompt()).toContain(
          "changed after freeze"
        );
      });
    });

    it("registers and removes runtime context blocks", async () => {
      const stub = env.SessionHarnessObject.getByName(crypto.randomUUID());
      await runInDurableObject(stub, async (instance: SessionHarnessObject) => {
        const session = instance.sessions.session();
        const block = await session.addContext("extension-memory");
        expect(block.writable).toBe(true);
        await session.replaceContextBlock("extension-memory", "remember this");
        expect(session.getContextBlock("extension-memory")?.content).toBe(
          "remember this"
        );
        expect(session.removeContext("extension-memory")).toBe(true);
        expect(session.getContextBlock("extension-memory")).toBeNull();
      });
    });

    it("restores loaded skills and reclaims their stored output on unload", async () => {
      const stub = env.SessionHarnessObject.getByName(crypto.randomUUID());
      await runInDurableObject(stub, async (instance: SessionHarnessObject) => {
        const skills: SkillProvider = {
          get: async () => "- guide: Project guide",
          load: async () => "full guide"
        };
        const sync = instance.sessions.__DO_NOT_USE_WILL_BREAK__sync();
        sync.ensureTables();
        sync.appendMessage("", {
          id: "skill-result",
          role: "assistant",
          parts: [
            {
              type: "tool-load_context",
              toolName: "load_context",
              toolCallId: "load-1",
              state: "output-available",
              input: { label: "skills", key: "guide" },
              output: "full guide"
            }
          ]
        });
        const session = instance.sessions
          .session()
          .withContext("skills", { provider: skills });

        expect(await session.getLoadedSkillKeys()).toEqual(
          new Set(["skills:guide"])
        );
        expect(await session.unloadSkill("skills", "guide")).toBe(true);
        const stored = await session.getMessage("skill-result", {
          reconstruct: "pointer"
        });
        expect(stored?.parts[0].output).toBe("[skill unloaded: guide]");
      });
    });

    it("includes context in the cheap auto-compaction trigger", async () => {
      const stub = env.SessionHarnessObject.getByName(crypto.randomUUID());
      await runInDurableObject(stub, async (instance: SessionHarnessObject) => {
        let compactions = 0;
        const session = instance.sessions
          .session()
          .withContext("soul", {
            provider: { get: async () => "context ".repeat(200) }
          })
          .onCompaction(async () => {
            compactions++;
            return null;
          })
          .compactAfter(100);

        await session.appendMessage(text("context-trigger", "short"));
        expect(compactions).toBe(1);
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
