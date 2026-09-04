import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { CutoverHarnessObject } from "../capabilities/streams";
import type { StreamChunk } from "../../streams";

/**
 * The cutover: temporary stream blocks → session message → delete the
 * blocks, in one SQLite transaction. Either the finished message exists
 * and the stream is gone, or the stream is still live and no message
 * exists; never neither, never both.
 */

async function collect(
  iterator: AsyncGenerator<StreamChunk, void, undefined>
): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = [];
  for await (const chunk of iterator) chunks.push(chunk);
  return chunks;
}

/** The harness's storage; `ctx` is protected on DurableObject. */
function sqlOf(instance: CutoverHarnessObject): SqlStorage {
  return (instance as unknown as { ctx: DurableObjectState }).ctx.storage.sql;
}

describe("stream → session cutover", () => {
  it("commits the message, settles and discards the stream together", async () => {
    const stub = env.CutoverHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: CutoverHarnessObject) => {
      await instance.lifecycle.start();
      const session = instance.sessions.session();
      const stream = await instance.streams.open("turn-1", { tag: "req-1" });
      const deltas: string[] = [];
      for (let i = 0; i < 300; i++) {
        deltas.push(`w${i} `);
        stream.append({ type: "text-delta", delta: `w${i} ` });
      }
      // One block row holds all 300 chunks (well under the block ceiling).
      const blocks = [
        ...sqlOf(instance).exec(
          "SELECT COUNT(*) AS n FROM cf_agents_stream_blocks WHERE stream_id = 'turn-1'"
        )
      ][0].n;
      expect(blocks).toBe(1);

      const message = {
        id: "m-1",
        role: "assistant" as const,
        parts: [{ type: "text" as const, text: deltas.join("") }]
      };
      let notify: (() => Promise<void>) | undefined;
      stream.close({
        commit: () => {
          notify = session
            .__DO_NOT_USE_WILL_BREAK__sync()
            .upsert(message).after;
        },
        discard: true
      });
      await notify?.();

      expect(await instance.streams.status("turn-1")).toBeNull();
      expect(await instance.streams.list({ tag: "req-1" })).toEqual([]);
      const rows = [
        ...sqlOf(instance).exec(
          "SELECT COUNT(*) AS n FROM cf_agents_stream_blocks"
        )
      ][0].n;
      expect(rows).toBe(0);
      const stored = await session.getMessage("m-1");
      expect(stored?.parts).toEqual(message.parts);
    });
  });

  it("a throwing commit rolls the settle back and leaves the stream live", async () => {
    const stub = env.CutoverHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: CutoverHarnessObject) => {
      await instance.lifecycle.start();
      const stream = await instance.streams.open("turn-2");
      stream.append("a");
      stream.append("b");
      expect(() =>
        stream.close({
          commit: () => {
            throw new Error("persist failed");
          },
          discard: true
        })
      ).toThrow("persist failed");
      expect((await instance.streams.status("turn-2"))?.state).toBe(
        "streaming"
      );
      expect(stream.append("c")).toBe(2);
      const all = await collect(
        (async function* () {
          for await (const batch of instance.streams.readBatches("turn-2", {
            onUpToDate: () => stream.close()
          })) {
            for (const c of batch) yield c;
          }
        })()
      );
      expect(all.map((c) => c.chunk)).toEqual(["a", "b", "c"]);
    });
  });

  it("blocks roll over and replay across the boundary", async () => {
    const stub = env.CutoverHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: CutoverHarnessObject) => {
      await instance.lifecycle.start();
      const stream = await instance.streams.open("big");
      const chunk = "x".repeat(60 * 1024);
      for (let i = 0; i < 12; i++) stream.append(`${i}:${chunk}`);
      stream.close();
      const blocks = [
        ...sqlOf(instance).exec(
          "SELECT block, seq_from, seq_to FROM cf_agents_stream_blocks WHERE stream_id = 'big' ORDER BY block"
        )
      ] as { block: number; seq_from: number; seq_to: number }[];
      // 256 KB ceiling, ~60 KB chunks: four per block, three blocks.
      expect(blocks.map((b) => [b.seq_from, b.seq_to])).toEqual([
        [0, 4],
        [4, 8],
        [8, 12]
      ]);
      const fromFive = await collect(instance.streams.read("big", { from: 5 }));
      expect(fromFive.map((c) => c.seq)).toEqual([5, 6, 7, 8, 9, 10, 11]);
      expect((fromFive[0].chunk as string).slice(0, 2)).toBe("5:");
      expect(await instance.streams.delete("big")).toBe(true);
      expect(
        [
          ...sqlOf(instance).exec(
            "SELECT COUNT(*) AS n FROM cf_agents_stream_blocks WHERE stream_id = 'big'"
          )
        ][0].n
      ).toBe(0);
    });
  });
});
