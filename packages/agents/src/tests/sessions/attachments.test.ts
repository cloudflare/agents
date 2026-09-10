import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { SessionHarnessObject } from "../capabilities/sessions";
import type { SessionMessage } from "../../sessions";
import { MAX_INLINE_ROW_BYTES } from "../../sessions/chunking";

/**
 * Attachments leave the message row.
 *
 * A part that declares a non-text media type and carries its bytes inline is
 * stored once, content-addressed, and referenced by a pointer. Reads put it
 * back verbatim, so nothing a host writes is lost or reshaped. Row chunking
 * still exists underneath for prose that is genuinely too large, and the two
 * mechanisms are independent: extraction is typed, chunking is a size backstop.
 */

/** A `data:` URL whose decoded payload is exactly `bytes` long. */
function dataUrl(mediaType: string, bytes: number, fill = "p"): string {
  return `data:${mediaType};base64,${btoa(fill.repeat(bytes))}`;
}

function fileMessage(
  id: string,
  url: string,
  mediaType: string,
  extra: Record<string, unknown> = {}
): SessionMessage {
  return {
    id,
    role: "user",
    parts: [
      { type: "text", text: "see attached" },
      { type: "file", mediaType, filename: "pic.png", url, ...extra }
    ]
  };
}

describe("Sessions attachments", () => {
  it("stores media outside the message row and reads it back verbatim", async () => {
    const stub = env.SessionHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: SessionHarnessObject) => {
      const session = instance.sessions.session();
      const url = dataUrl("image/png", 300_000);
      const message = fileMessage("m1", url, "image/png");
      await session.appendMessage(message);

      // The payload is nowhere near the row: only the pointer is.
      expect(instance.messageRowBytes("", "m1")).toBeLessThan(1_000);
      expect(instance.contentChunks("", "m1")).toBe(0);

      const records = instance.attachmentRecords();
      expect(records).toHaveLength(1);
      expect(records[0].bytes).toBe(300_000);
      expect(records[0].mediaType).toBe("image/png");
      expect(instance.attachmentRefCount()).toBe(1);

      // ...and a read is byte-identical to what was written.
      const [read] = await session.getHistory();
      expect(read).toEqual(message);
    });
  });

  it("never extracts text, which chunks instead", async () => {
    const stub = env.SessionHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: SessionHarnessObject) => {
      const session = instance.sessions.session();
      const body = "x".repeat(MAX_INLINE_ROW_BYTES + 200_000);
      const message: SessionMessage = {
        id: "m1",
        role: "assistant",
        parts: [{ type: "text", text: body }]
      };
      await session.appendMessage(message);

      // Prose is the chunker's job, not the attachment store's.
      expect(instance.attachmentRecords()).toHaveLength(0);
      expect(instance.contentChunks("", "m1")).toBeGreaterThan(0);
      const [read] = await session.getHistory();
      expect(read).toEqual(message);
    });
  });

  it("leaves a text/* data URL in the message", async () => {
    const stub = env.SessionHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: SessionHarnessObject) => {
      const session = instance.sessions.session();
      const url = dataUrl("text/plain", 40_000);
      await session.appendMessage(fileMessage("m1", url, "text/plain"));

      expect(instance.attachmentRecords()).toHaveLength(0);
      const [read] = await session.getHistory();
      expect(read.parts[1].url).toBe(url);
    });
  });

  it("stores one record when the same payload arrives twice", async () => {
    const stub = env.SessionHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: SessionHarnessObject) => {
      const session = instance.sessions.session();
      const url = dataUrl("image/png", 120_000);
      await session.appendMessage(fileMessage("m1", url, "image/png"));
      await session.appendMessage(fileMessage("m2", url, "image/png"));

      // Content addressing makes the second write idempotent; both messages
      // still reference it, which is what keeps it alive.
      expect(instance.attachmentRecords()).toHaveLength(1);
      expect(instance.attachmentRefCount()).toBe(2);

      const history = await session.getHistory();
      expect(history[0].parts[1].url).toBe(url);
      expect(history[1].parts[1].url).toBe(url);
    });
  });

  it("splits a payload larger than one row across chunks", async () => {
    const stub = env.SessionHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: SessionHarnessObject) => {
      const session = instance.sessions.session();
      const bytes = MAX_INLINE_ROW_BYTES + 500_000;
      const message = fileMessage(
        "m1",
        dataUrl("image/png", bytes),
        "image/png"
      );
      await session.appendMessage(message);

      expect(instance.attachmentChunkCount()).toBe(2);
      expect(instance.messageRowBytes("", "m1")).toBeLessThan(1_000);
      // The message row never chunked, because the payload left before it was
      // measured — extraction and chunking are independent.
      expect(instance.contentChunks("", "m1")).toBe(0);

      const [read] = await session.getHistory();
      expect(read).toEqual(message);
    });
  });

  it("extracts media nested in tool output", async () => {
    const stub = env.SessionHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: SessionHarnessObject) => {
      const session = instance.sessions.session();
      const message: SessionMessage = {
        id: "m1",
        role: "assistant",
        parts: [
          {
            type: "tool-screenshot",
            toolCallId: "call-1",
            state: "output-available",
            output: {
              content: [
                { type: "text", text: "captured" },
                {
                  type: "media",
                  mediaType: "image/png",
                  data: btoa("z".repeat(200_000))
                }
              ]
            }
          }
        ]
      };
      await session.appendMessage(message);

      // This is the shape that produced the largest real messages measured in
      // pi transcripts: a tool result carrying an inline image.
      expect(instance.attachmentRecords()).toHaveLength(1);
      expect(instance.attachmentRecords()[0].bytes).toBe(200_000);
      expect(instance.messageRowBytes("", "m1")).toBeLessThan(1_000);

      const [read] = await session.getHistory();
      expect(read).toEqual(message);
    });
  });

  it("charges payload bytes to the read budget", async () => {
    const stub = env.SessionHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: SessionHarnessObject) => {
      const session = instance.sessions.session();
      await session.appendMessage(
        fileMessage("m1", dataUrl("image/png", 600_000), "image/png")
      );

      // A budget that counted only the row would think this message costs a
      // few hundred bytes and admit a window far larger than it measured.
      const [stat] = await session.getHistoryRowStats();
      expect(stat.bytes).toBeGreaterThan(700_000);
    });
  });

  it("does not let a run of media-heavy messages exceed the read budget", async () => {
    const stub = env.SessionHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: SessionHarnessObject) => {
      const session = instance.sessions.session();
      for (let i = 0; i < 8; i++) {
        await session.appendMessage(
          fileMessage(
            `m${i}`,
            dataUrl("image/png", 400_000, String(i)),
            "image/png"
          )
        );
      }

      // Eight messages, each roughly 533 KB once inlined. A budget of 1.5 MB
      // must admit about two of them — a message-count floor that ignored size
      // would have hydrated all eight, which is exactly the exhaustion the
      // budget exists to prevent.
      const budget = 1_500_000;
      const recent = await session.getRecentHistory(budget);

      expect(recent.messages.length).toBeLessThanOrEqual(3);
      expect(recent.truncated).toBe(true);
      const hydrated = recent.messages.reduce(
        (sum, message) => sum + JSON.stringify(message).length,
        0
      );
      expect(hydrated).toBeLessThan(budget * 1.1);
    });
  });

  it("inlines payloads only for the newest rows the policy names", async () => {
    const stub = env.SessionHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: SessionHarnessObject) => {
      const session = instance.sessions.session();
      const urls: string[] = [];
      for (let i = 0; i < 6; i++) {
        urls.push(dataUrl("image/png", 100_000, String(i)));
        await session.appendMessage(fileMessage(`m${i}`, urls[i], "image/png"));
      }

      const all = await session.getRecentHistory(64 * 1024 * 1024);
      const tail = await session.getRecentHistory(64 * 1024 * 1024, {
        inlineAttachments: { newest: 2 }
      });
      expect(tail.messages.map((m) => m.id)).toEqual(
        all.messages.map((m) => m.id)
      );
      expect(tail.truncated).toBe(false);

      // The newest two read back verbatim; the rest keep their pointers,
      // with every other field of the part intact.
      const fileOf = (message: SessionMessage) =>
        message.parts[1] as {
          url: string;
          mediaType: string;
          filename: string;
        };
      expect(fileOf(tail.messages[5]).url).toBe(urls[5]);
      expect(fileOf(tail.messages[4]).url).toBe(urls[4]);
      for (const message of tail.messages.slice(0, 4)) {
        const part = fileOf(message);
        expect(part.url).toMatch(/^attachment:sha256:[0-9a-f]{64}$/);
        expect(part.mediaType).toBe("image/png");
        expect(part.filename).toBe("pic.png");
      }

      // What stays resident shrinks by the media share of the older rows.
      const size = (messages: SessionMessage[]) =>
        messages.reduce((sum, m) => sum + JSON.stringify(m).length, 0);
      expect(size(all.messages)).toBeGreaterThan(6 * 130_000);
      expect(size(tail.messages)).toBeLessThan(2 * 140_000 + 6 * 1_000);
    });
  });

  it("keeps a pointer's reference when the message is written back", async () => {
    const stub = env.SessionHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: SessionHarnessObject) => {
      const session = instance.sessions.session();
      const url = dataUrl("image/png", 80_000);
      await session.appendMessage(fileMessage("m1", url, "image/png"));
      await session.appendMessage({
        id: "m2",
        role: "assistant",
        parts: [{ type: "text", text: "nice picture" }]
      });

      const { messages } = await session.getRecentHistory(64 * 1024 * 1024, {
        inlineAttachments: { newest: 1 }
      });
      const pointer = messages[0];
      expect((pointer.parts[1] as { url: string }).url).toMatch(/^attachment:/);

      // A host that holds the pointer form and patches the message — a tool
      // update, a metadata stamp — writes the pointer back. The reference
      // must survive, or the payload is collected under a live pointer.
      await session.updateMessage({
        ...pointer,
        parts: [
          { type: "text", text: "see attached (edited)" },
          pointer.parts[1]
        ]
      });
      expect(instance.attachmentRecords()).toHaveLength(1);
      expect(instance.attachmentRefCount()).toBe(1);
      const [full] = await session.getHistory();
      expect((full.parts[1] as { url: string }).url).toBe(url);

      // A copy under a new id (a regenerate or branch that re-appends cached
      // messages) takes its own reference, so deleting the original does
      // not take the bytes with it.
      await session.appendMessage({ ...pointer, id: "m3" });
      expect(instance.attachmentRefCount()).toBe(2);
      await session.deleteMessages(["m1"]);
      expect(instance.attachmentRecords()).toHaveLength(1);
      const copy = await session.getMessage("m3");
      expect(copy).not.toBeNull();
      expect((copy!.parts[1] as { url: string }).url).toBe(url);
    });
  });

  it("returns null for an update whose target is gone and stores nothing", async () => {
    const stub = env.SessionHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: SessionHarnessObject) => {
      const session = instance.sessions.session();
      const original = fileMessage(
        "m1",
        dataUrl("image/png", 80_000),
        "image/png"
      );
      await session.appendMessage(original);
      await session.deleteMessages(["m1"]);

      // The row is gone, so the write returns null and the payload it
      // carried is not re-stored.
      expect(await session.updateMessage(original)).toBeNull();
      expect(instance.attachmentRecords()).toHaveLength(0);
    });
  });

  it("collects a payload once its last reference goes", async () => {
    const stub = env.SessionHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: SessionHarnessObject) => {
      const session = instance.sessions.session();
      const url = dataUrl("image/png", 90_000);
      await session.appendMessage(fileMessage("m1", url, "image/png"));
      await session.appendMessage(fileMessage("m2", url, "image/png"));

      await session.deleteMessages(["m1"]);
      // Still referenced by m2, so the bytes stay.
      expect(instance.attachmentRecords()).toHaveLength(1);
      expect(instance.attachmentRefCount()).toBe(1);

      await session.deleteMessages(["m2"]);
      expect(instance.attachmentRecords()).toHaveLength(0);
      expect(instance.attachmentChunkCount()).toBe(0);
      expect(instance.attachmentRefCount()).toBe(0);
    });
  });

  it("drops payloads a message stopped referencing on update", async () => {
    const stub = env.SessionHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: SessionHarnessObject) => {
      const session = instance.sessions.session();
      await session.appendMessage(
        fileMessage("m1", dataUrl("image/png", 70_000), "image/png")
      );
      expect(instance.attachmentRecords()).toHaveLength(1);

      await session.updateMessage({
        id: "m1",
        role: "user",
        parts: [{ type: "text", text: "never mind" }]
      });
      expect(instance.attachmentRecords()).toHaveLength(0);
      expect(instance.attachmentRefCount()).toBe(0);
    });
  });

  it("treats a re-sent identical payload as an unchanged update", async () => {
    const stub = env.SessionHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: SessionHarnessObject) => {
      const session = instance.sessions.session();
      const message = fileMessage(
        "m1",
        dataUrl("image/png", 60_000),
        "image/png"
      );
      await session.appendMessage(message);

      // The comparison happens in stored form, so the identical image resolves
      // to the same address and the write is correctly recognised as a no-op:
      // no update event, and no second copy of the payload.
      await session.updateMessage({ ...message });
      expect(instance.eventsOfType("session:message:updated")).toHaveLength(0);
      expect(instance.attachmentRecords()).toHaveLength(1);
      expect(instance.attachmentRefCount()).toBe(1);
    });
  });

  it("clears every payload with the session", async () => {
    const stub = env.SessionHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: SessionHarnessObject) => {
      const session = instance.sessions.session();
      await session.appendMessage(
        fileMessage("m1", dataUrl("image/png", 40_000), "image/png")
      );
      await session.appendMessage(
        fileMessage("m2", dataUrl("image/jpeg", 45_000), "image/jpeg")
      );
      expect(instance.attachmentRecords()).toHaveLength(2);

      await session.clearMessages();
      expect(instance.attachmentRecords()).toHaveLength(0);
      expect(instance.attachmentChunkCount()).toBe(0);
      expect(instance.attachmentRefCount()).toBe(0);
    });
  });
});
