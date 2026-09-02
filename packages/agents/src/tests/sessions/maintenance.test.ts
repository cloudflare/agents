import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  parseAttachmentUrl,
  Sessions,
  type SessionChangeEvent,
  type SessionMessage
} from "../../sessions";
import type { SessionHarnessObject } from "../capabilities/sessions";
import { withCapabilityHarness } from "../shared/capability-harness";

/**
 * The maintenance pass drains inline payloads out of AGED rows with exactly
 * the policy the write path applies, so a legacy row ends up as if it had
 * been written today. There is no lossy mode any more: nothing is dropped,
 * nothing is truncated, and every payload reconstructs byte for byte after a
 * pass. Recent rows are never touched, so the model's hot window never pays
 * a reconstruction read.
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

  it("drains media written under a looser policy", async () => {
    await withCapabilityHarness(async ({ install }) => {
      let inlineThresholdBytes = Number.MAX_SAFE_INTEGER;
      const { capability, lifecycle } = install(
        new Sessions({
          attachments: () => ({ inlineThresholdBytes, keepRecentMessages: 2 })
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

      inlineThresholdBytes = 1024;
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

  it("leaves aged conversation text inline and stops rediscovering it", async () => {
    const stub = env.SessionHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: SessionHarnessObject) => {
      const session = instance.sessions.session();
      // Prose is conversation, not media: only the row budget moves it, and
      // this row is far below it. The candidate hint must be corrected so a
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

  it("can be switched off entirely", async () => {
    await withCapabilityHarness(async ({ install }) => {
      const { capability, lifecycle } = install(
        new Sessions({
          attachments: {
            inlineThresholdBytes: Number.MAX_SAFE_INTEGER,
            keepRecentMessages: 2,
            maintenance: false
          }
        })
      );
      await lifecycle.start();
      const session = capability.session();
      const original = imageMessage("off-aged", 4096);
      await session.appendMessage(original);
      await ageOut(session, "off");

      expect(await session.runMaintenance()).toBeNull();
      expect(
        await session.getMessage("off-aged", { reconstruct: "pointer" })
      ).toEqual(original);
    });
  });
});
