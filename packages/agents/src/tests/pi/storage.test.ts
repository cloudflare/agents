import {
  BACKGROUND_CONTEXT,
  StorageBackedSession
} from "@earendil-works/pi-agent-core";
import { SqliteStorage } from "@earendil-works/pi-session-backend-sqlite-node";
import { describe, expect, it } from "vitest";
import { DurableObjectPiDatabase, ensurePiSession } from "../../pi/storage";
import { withCapabilityHarness } from "../shared/capability-harness";

describe("Pi Durable Object storage", () => {
  it("restores one Pi session from Durable Object SQLite", async () => {
    await withCapabilityHarness(async ({ storage }) => {
      const metadata = await ensurePiSession(storage);
      const first = new StorageBackedSession(
        metadata,
        new SqliteStorage(new DurableObjectPiDatabase(storage), {
          sessionId: metadata.id
        })
      );
      const branch = await first.createBranch("main", null, BACKGROUND_CONTEXT);
      const entryId = await branch.appendMessage(
        {
          role: "user",
          content: [{ type: "text", text: "hello" }],
          timestamp: 1
        },
        BACKGROUND_CONTEXT
      );
      await first.close(BACKGROUND_CONTEXT);

      const restoredMetadata = await ensurePiSession(storage);
      const second = new StorageBackedSession(
        restoredMetadata,
        new SqliteStorage(new DurableObjectPiDatabase(storage), {
          sessionId: restoredMetadata.id
        })
      );
      const restored = await second.getEntry(entryId, BACKGROUND_CONTEXT);

      expect(restoredMetadata.id).toBe(metadata.id);
      expect(restored).toMatchObject({
        id: entryId,
        type: "message",
        message: { role: "user" }
      });
      await second.close(BACKGROUND_CONTEXT);
    });
  });
});
