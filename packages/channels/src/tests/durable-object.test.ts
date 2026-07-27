import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createTurnEngine } from "../engine/durable-object";
import { freshName, textPart } from "./harness";

/** Public Durable Object construction seam. */
describe("createTurnEngine", () => {
  it("runs a durable turn and arms journal retention", async () => {
    const stub = env.TestBed.get(
      env.TestBed.idFromName(freshName("durable-engine"))
    );

    await runInDurableObject(stub, async (_instance, state) => {
      const engine = createTurnEngine(state, {
        connector: {
          run: () => textPart("answer", "hello")
        }
      });

      const admission = await engine.submit({
        conversationId: "conversation-1",
        input: [],
        sourceEventId: "event-1"
      });
      const settled = await engine.waitForSettlement(admission.turn!.id);

      expect(settled.outcome).toBe("ok");
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if ((await state.storage.getAlarm()) !== null) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      expect(await state.storage.getAlarm()).not.toBeNull();
      const journal = [];
      for await (const entry of engine.openJournal(settled.id)) {
        journal.push(entry.chunk.type);
      }
      expect(journal).toEqual(["text-start", "text-delta", "text-end"]);
    });
  });
});
