import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  parseAttachmentUrl,
  Sessions,
  type SessionChangeEvent,
  type SessionMessage
} from "../../sessions";
import {
  MemoryAttachmentBucket,
  type SessionHarnessObject
} from "../capabilities/sessions";
import { withCapabilityHarness } from "../shared/capability-harness";

/**
 * The maintenance pass drains inline payloads out of AGED rows into R2, with
 * exactly the policy the write path applies, so a legacy row ends up as if it
 * had been written today. Nothing is dropped or truncated, and every payload
 * reconstructs byte for byte after a pass. Recent rows are never touched, so
 * the model's hot window never pays a reconstruction read.
 *
 * Without a bucket the pass has nowhere useful to move anything — SQLite
 * chunks sit in the same Durable Object as the row they came out of — so it
 * does nothing at all.
 */

function text(id: string, body: string, role = "user"): SessionMessage {
  return { id, role, parts: [{ type: "text", text: body }] };
}

function imageMessage(id: string, payloadBytes: number): SessionMessage {
  return {
    id,
    role: "user",
    parts: [
      { type: "text", text: "see attached" },
      {
        type: "file",
        mediaType: "image/png",
        filename: "pic.png",
        url: `data:image/png;base64,${btoa("p".repeat(payloadBytes))}`
      }
    ]
  };
}

/**
 * Seed rows that predate offload. The legacy lift is the only way to put an
 * inline payload into storage that the write path would have externalized,
 * which is exactly the state maintenance exists to drain.
 */
function seedAged(
  instance: SessionHarnessObject,
  messages: SessionMessage[]
): void {
  const statements = [
    `CREATE TABLE assistant_messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL DEFAULT '',
      parent_id TEXT,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`
  ];
  messages.forEach((message, index) => {
    const parent = index === 0 ? "NULL" : `'${messages[index - 1].id}'`;
    const content = JSON.stringify(message).replaceAll("'", "''");
    const second = String(index + 1).padStart(2, "0");
    statements.push(
      `INSERT INTO assistant_messages
         (id, session_id, parent_id, role, content, created_at)
       VALUES ('${message.id}', '', ${parent}, '${message.role}', '${content}',
         '2026-01-02 03:04:${second}')`
    );
  });
  instance.seedLegacy(statements);
}

/** Push the seeded rows out of the recent window (keepRecentMessages: 2). */
async function ageOut(
  session: { appendMessage(message: SessionMessage): Promise<unknown> },
  prefix: string
): Promise<void> {
  await session.appendMessage(text(`${prefix}-recent-1`, "one"));
  await session.appendMessage(text(`${prefix}-recent-2`, "two"));
}

describe("Sessions maintenance", () => {
  it("externalizes an aged file part and reconstructs it byte for byte", async () => {
    const stub = env.SessionHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: SessionHarnessObject) => {
      instance.useAttachmentBucket();
      const original = imageMessage("aged-image", 4096);
      seedAged(instance, [original]);

      const session = instance.sessions.session();
      await ageOut(session, "image");

      const result = await session.runMaintenance();
      expect(result).toMatchObject({
        messages: 1,
        parts: 1,
        backlogRemains: false
      });
      // `bytes` is the payload size estimated from the data URL, not the
      // exact decoded length.
      expect(result?.bytes).toBeGreaterThanOrEqual(4096);
      expect(instance.attachmentBlobCount()).toBe(1);
      expect((await session.stats()).attachmentBytes).toBe(4096);

      const stored = await session.getMessage("aged-image", {
        reconstruct: "pointer"
      });
      expect(parseAttachmentUrl(stored?.parts[1].url)).toMatch(
        /^[0-9a-f]{64}$/
      );
      // Nothing was lost: the default read inlines the exact original bytes.
      expect(await session.getMessage("aged-image")).toEqual(original);
    });
  });

  it("externalizes aged media nested in tool output without reshaping it", async () => {
    const stub = env.SessionHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: SessionHarnessObject) => {
      instance.useAttachmentBucket();
      const screenshot = `data:image/png;base64,${btoa("s".repeat(4096))}`;
      const original: SessionMessage = {
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
              frames: [{ image: screenshot }, { image: "small" }]
            }
          }
        ]
      };
      seedAged(instance, [original]);

      const session = instance.sessions.session();
      await ageOut(session, "tool");

      expect(await session.runMaintenance()).toMatchObject({
        messages: 1,
        parts: 1
      });

      const stored = await session.getMessage("aged-tool", {
        reconstruct: "pointer"
      });
      const output = stored?.parts[0].output as {
        note: string;
        frames: Array<{ image: string }>;
      };
      // A screenshot is media wherever a tool put it; the container survives.
      expect(output.note).toBe("kept");
      expect(output.frames[1].image).toBe("small");
      expect(output.frames[0].image).toContain("attachment:sha256:");
      expect((await session.stats()).attachmentBytes).toBe(4096);

      // The inline read restores the original object exactly.
      expect(await session.getMessage("aged-tool")).toEqual(original);
    });
  });

  it("drains payloads written under a looser threshold", async () => {
    await withCapabilityHarness(async ({ install }) => {
      let r2ThresholdBytes = Number.MAX_SAFE_INTEGER;
      const bucket = new MemoryAttachmentBucket();
      const { capability, lifecycle } = install(
        new Sessions({
          attachments: () => ({
            r2: bucket,
            r2ThresholdBytes,
            keepRecentMessages: 2
          })
        })
      );
      await lifecycle.start();
      const session = capability.session();
      const original = imageMessage("aged-file", 2048);
      await session.appendMessage(original);
      await ageOut(session, "file");

      // Nothing is aged past the policy in force when the rows were written.
      expect(await session.runMaintenance()).toMatchObject({
        messages: 0,
        backlogRemains: false
      });

      r2ThresholdBytes = 1024;
      expect(await session.runMaintenance()).toMatchObject({
        messages: 1,
        parts: 1,
        backlogRemains: false
      });
      const stored = await session.getMessage("aged-file", {
        reconstruct: "pointer"
      });
      expect(parseAttachmentUrl(stored?.parts[1].url)).toBeTruthy();
      expect(await session.getMessage("aged-file")).toEqual(original);
    });
  });

  it("leaves recent rows inline", async () => {
    const stub = env.SessionHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: SessionHarnessObject) => {
      instance.useAttachmentBucket();
      const original = imageMessage("recent-image", 4096);
      seedAged(instance, [original]);

      // Only one row on the path, so the recent window covers it entirely.
      const session = instance.sessions.session();
      expect(await session.runMaintenance()).toMatchObject({
        messages: 0,
        backlogRemains: false
      });
      expect(instance.attachmentBlobCount()).toBe(0);
      expect(
        await session.getMessage("recent-image", { reconstruct: "pointer" })
      ).toEqual(original);
    });
  });

  it("leaves an aged payload below the threshold inline and stops rediscovering it", async () => {
    const stub = env.SessionHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: SessionHarnessObject) => {
      instance.useAttachmentBucket(64 * 1024);
      const session = instance.sessions.session();
      // Below the R2 threshold and far below the row budget, so there is
      // nothing worth moving. The candidate hint must reflect that, so a
      // bounded pass makes progress instead of re-examining the row forever.
      const prose = text("aged-prose", "long ".repeat(1000));
      await session.appendMessage(prose);
      await ageOut(session, "prose");

      expect(await session.runMaintenance()).toMatchObject({
        messages: 0,
        backlogRemains: false
      });
      expect(await session.runMaintenance()).toMatchObject({
        messages: 0,
        backlogRemains: false
      });
      expect(instance.attachmentBlobCount()).toBe(0);
      expect(await session.getMessage("aged-prose")).toEqual(prose);
    });
  });

  it("reports maintenance rewrites on the change feed and in telemetry", async () => {
    const stub = env.SessionHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: SessionHarnessObject) => {
      instance.useAttachmentBucket();
      seedAged(instance, [imageMessage("feed-aged", 4096)]);
      const events: SessionChangeEvent[] = [];
      instance.sessions.subscribe((event) => {
        events.push(event);
      });
      const session = instance.sessions.session();
      await ageOut(session, "feed");
      await session.runMaintenance();

      const rewrites = events.filter(
        (event) => event.type === "maintenance-rewrite"
      );
      expect(rewrites).toHaveLength(1);
      const rewrite = rewrites[0];
      if (rewrite.type !== "maintenance-rewrite") {
        throw new Error("expected maintenance-rewrite");
      }
      expect(rewrite.message.id).toBe("feed-aged");
      expect(parseAttachmentUrl(rewrite.message.parts[1].url)).toBeTruthy();

      const completed = instance.eventsOfType("session:maintenance:completed");
      expect(completed).toHaveLength(1);
      expect(completed[0].payload).toMatchObject({ messages: 1, parts: 1 });
    });
  });

  it("is bounded per pass and reports the remaining backlog", async () => {
    const stub = env.SessionHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: SessionHarnessObject) => {
      instance.useAttachmentBucket();
      seedAged(
        instance,
        Array.from({ length: 5 }, (_, index) =>
          imageMessage(`backlog-${index}`, 2048 + index)
        )
      );
      const session = instance.sessions.session();
      await ageOut(session, "backlog");

      // maxMaintenanceRowsPerPass is 2 on this harness.
      expect(await session.runMaintenance()).toMatchObject({
        messages: 2,
        backlogRemains: true
      });
      expect(await session.runMaintenance()).toMatchObject({
        messages: 2,
        backlogRemains: true
      });
      expect(await session.runMaintenance()).toMatchObject({
        messages: 1,
        backlogRemains: false
      });
      expect(instance.attachmentBlobCount()).toBe(5);
    });
  });

  it("chains its own follow-up passes until the backlog drains", async () => {
    const stub = env.SessionHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: SessionHarnessObject) => {
      instance.useAttachmentBucket();
      seedAged(
        instance,
        Array.from({ length: 5 }, (_, index) =>
          imageMessage(`chain-${index}`, 2048 + index)
        )
      );
      const session = instance.sessions.session();
      await ageOut(session, "chain");

      // One explicit pass handles two rows and must schedule the rest itself.
      // The reschedule runs on a timer, so it can only fire once this call
      // has released the running flag.
      expect(await session.runMaintenance()).toMatchObject({
        messages: 2,
        backlogRemains: true
      });
      for (
        let tick = 0;
        tick < 50 && instance.attachmentBlobCount() < 5;
        tick++
      ) {
        await scheduler.wait(1);
      }
      expect(instance.attachmentBlobCount()).toBe(5);
    });
  });

  it("uses compare-and-swap so maintenance cannot overwrite a live rewrite", async () => {
    const stub = env.SessionHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: SessionHarnessObject) => {
      instance.useAttachmentBucket();
      seedAged(instance, [imageMessage("racy", 4096)]);
      const session = instance.sessions.session();
      await ageOut(session, "race");

      // The blob lands before the row commits, so a concurrent rewrite that
      // slips in there must lose the row and take its bytes with it.
      instance.onAttachmentStored = () => {
        instance.onAttachmentStored = undefined;
        instance.overwriteMessageContent(
          "",
          "racy",
          JSON.stringify(text("racy", "live rewrite"))
        );
      };

      expect(await session.runMaintenance()).toMatchObject({ messages: 0 });
      expect((await session.getMessage("racy"))?.parts[0].text).toBe(
        "live rewrite"
      );
      expect(instance.attachmentBlobCount()).toBe(0);
    });
  });

  it("does nothing at all without a bucket", async () => {
    const stub = env.SessionHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: SessionHarnessObject) => {
      // No bucket: chunking these bytes would leave them in this same
      // Durable Object, so inline is where they belong and the pass is a
      // no-op no matter how old the row is.
      const session = instance.sessions.session();
      const original = imageMessage("no-bucket", 200 * 1024);
      await session.appendMessage(original);
      await ageOut(session, "no-bucket");

      expect(await session.runMaintenance()).toEqual({
        messages: 0,
        parts: 0,
        bytes: 0,
        backlogRemains: false
      });
      expect(instance.attachmentBlobCount()).toBe(0);
      expect(
        await session.getMessage("no-bucket", { reconstruct: "pointer" })
      ).toEqual(original);
    });
  });

  it("can be switched off entirely", async () => {
    await withCapabilityHarness(async ({ install }) => {
      let r2ThresholdBytes = Number.MAX_SAFE_INTEGER;
      const { capability, lifecycle } = install(
        new Sessions({
          attachments: () => ({
            r2: new MemoryAttachmentBucket(),
            r2ThresholdBytes,
            keepRecentMessages: 2,
            maintenance: false
          })
        })
      );
      await lifecycle.start();
      const session = capability.session();
      const original = imageMessage("off-aged", 4096);
      await session.appendMessage(original);
      await ageOut(session, "off");

      // A threshold this row is now over: only `maintenance: false` keeps
      // the pass from draining it.
      r2ThresholdBytes = 1024;
      expect(await session.runMaintenance()).toBeNull();
      expect(
        await session.getMessage("off-aged", { reconstruct: "pointer" })
      ).toEqual(original);
    });
  });
});
