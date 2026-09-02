import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { SessionHarnessObject } from "../capabilities/sessions";
import type { SessionMessage } from "../../sessions";
import { MAX_INLINE_ROW_BYTES } from "../../sessions";

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

  it("keeps the pointer when a caller asks not to materialize payloads", async () => {
    const stub = env.SessionHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: SessionHarnessObject) => {
      const session = instance.sessions.session();
      await session.appendMessage(
        fileMessage("m1", dataUrl("image/png", 50_000), "image/png")
      );

      const [pointed] = await session.getHistory({ attachments: "pointer" });
      expect(pointed.parts[1].url).toMatch(/^attachment:sha256:[0-9a-f]{64}$/);
      // The declared type survives, so a reader knows what it is pointing at
      // without loading a byte of it.
      expect(pointed.parts[1].mediaType).toBe("image/png");
      expect(pointed.parts[1].filename).toBe("pic.png");
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

  it("returns and emits inline form even when handed pointers", async () => {
    const stub = env.SessionHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: SessionHarnessObject) => {
      const session = instance.sessions.session();
      const original = fileMessage(
        "m1",
        dataUrl("image/png", 90_000),
        "image/png"
      );
      await session.appendMessage(original);

      // A caller that reads pointers and writes them back is the case that
      // breaks a naive contract: the write path must not let pointer form
      // leak into results or the change feed.
      const [pointed] = await session.getHistory({ attachments: "pointer" });

      const emitted: SessionMessage[] = [];
      const unsubscribe = instance.sessions.subscribe((event) => {
        if (event.type === "append" || event.type === "update") {
          emitted.push(event.message);
        }
      });

      // Appending it under a fresh id inserts; appending again is a duplicate.
      // Both must come back the same shape.
      const first = await session.appendMessage({ ...pointed, id: "m2" });
      const retry = await session.appendMessage({ ...pointed, id: "m2" });
      unsubscribe();

      expect(first.message.parts[1].url).toBe(original.parts[1].url);
      expect(retry.message.parts[1].url).toBe(original.parts[1].url);
      expect(retry.message).toEqual(first.message);

      // ...and nothing pointer-shaped reached a subscriber.
      expect(emitted.length).toBeGreaterThan(0);
      for (const message of emitted) {
        expect(JSON.stringify(message)).not.toContain("attachment:sha256:");
      }
    });
  });

  it("inlines a pointer-form update before returning or emitting it", async () => {
    const stub = env.SessionHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: SessionHarnessObject) => {
      const session = instance.sessions.session();
      const original = fileMessage(
        "m1",
        dataUrl("image/png", 70_000),
        "image/png"
      );
      await session.appendMessage(original);

      const [pointed] = await session.getHistory({ attachments: "pointer" });
      const emitted: SessionMessage[] = [];
      const unsubscribe = instance.sessions.subscribe((event) => {
        if (event.type === "update") emitted.push(event.message);
      });

      const updated = await session.updateMessage({
        ...pointed,
        parts: [{ type: "text", text: "edited" }, pointed.parts[1]]
      });
      unsubscribe();

      expect(updated?.parts[1].url).toBe(original.parts[1].url);
      expect(emitted).toHaveLength(1);
      expect(JSON.stringify(emitted[0])).not.toContain("attachment:sha256:");
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

  it("keeps payloads alive when a pointer-mode read is written back", async () => {
    const stub = env.SessionHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: SessionHarnessObject) => {
      const session = instance.sessions.session();
      const original = fileMessage(
        "m1",
        dataUrl("image/png", 80_000),
        "image/png"
      );
      await session.appendMessage(original);

      // A host that reads pointers and writes the message back is holding a
      // reference extraction never saw. If references came only from what this
      // write extracted, the payload would be collected out from under a
      // message still pointing at it.
      const [pointed] = await session.getHistory({ attachments: "pointer" });
      await session.updateMessage({
        ...pointed,
        parts: [{ type: "text", text: "edited" }, pointed.parts[1]]
      });

      expect(instance.attachmentRecords()).toHaveLength(1);
      expect(instance.attachmentRefCount()).toBe(1);
      const [reread] = await session.getHistory();
      expect(reread.parts[1].url).toBe(original.parts[1].url);
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
