import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { SessionHarnessObject } from "../capabilities/sessions";
import type { SessionMessage } from "../../sessions";
import { COMPACTION_PREFIX, Oracle } from "./oracle";

/**
 * Seeded random sequences of appends, branch appends, compactions, deletes
 * and reads, each read compared with an independent model of the session
 * (`oracle.ts`). Any difference fails with the seed and the step.
 */

/** Mulberry32: small, seeded, deterministic. */
function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (n: number) => Math.floor(next() * n),
    pick: <T>(list: readonly T[]): T => list[Math.floor(next() * list.length)]
  };
}

function text(id: string): SessionMessage {
  return { id, role: "user", parts: [{ type: "text", text: `${id} body` }] };
}

/** Map a session's compaction ids to the oracle's, by message id. */
function normalize(ids: readonly string[], names: ReadonlyMap<string, string>) {
  return ids.map((id) =>
    id.startsWith(COMPACTION_PREFIX)
      ? `${COMPACTION_PREFIX}${names.get(id.slice(COMPACTION_PREFIX.length)) ?? "?"}`
      : id
  );
}

async function run(seed: number, steps: number) {
  const stub = env.SessionHarnessObject.getByName(`property-${seed}`);
  await runInDurableObject(stub, async (instance: SessionHarnessObject) => {
    const session = instance.sessions.session();
    const oracle = new Oracle();
    const random = rng(seed);
    /** Session compaction id → oracle overlay id. */
    const names = new Map<string, string>();
    let counter = 0;

    const check = async (step: number, op: string) => {
      const where = `seed ${seed}, step ${step} (${op})`;
      const leaves = [oracle.leaf, ...[...oracle.rows.keys()].slice(-3)];
      for (const leaf of leaves) {
        if (leaf === null) continue;
        const expected = oracle.visibleIds(leaf);
        const ids = (await session.getHistory({ leafId: leaf })).map(
          (m) => m.id
        );
        expect(normalize(ids, names), where).toEqual(expected);
        const backward: string[] = [];
        for await (const m of session.history({
          leafId: leaf,
          newestFirst: true
        })) {
          backward.push(m.id);
        }
        expect(normalize(backward, names), where).toEqual(
          [...expected].reverse()
        );
        const budget = 1 + random.int(4_000);
        const recent = await session.getRecentHistory(budget, {
          leafId: leaf
        });
        const tail = normalize(
          recent.messages.map((m) => m.id),
          names
        );
        expect(tail, where).toEqual(
          expected.slice(expected.length - tail.length)
        );
        expect(recent.truncated, where).toBe(tail.length < expected.length);
      }
      if (oracle.leaf === null) {
        expect(await session.getHistory(), where).toEqual([]);
      }
    };

    for (let step = 0; step < steps; step++) {
      const roll = random.next();
      const ids = [...oracle.rows.keys()];
      let op: string;
      if (roll < 0.45 || ids.length < 4) {
        const id = `r${counter++}`;
        op = `append ${id}`;
        oracle.append(id);
        await session.appendMessage(text(id));
      } else if (roll < 0.6) {
        const id = `r${counter++}`;
        const parent = random.pick(ids);
        op = `branch ${id} under ${parent}`;
        oracle.append(id, parent);
        await session.appendMessage(text(id), { parentId: parent });
      } else if (roll < 0.8) {
        // Mostly anchors on the current path, sometimes any two rows.
        const path = oracle.rawPath();
        const onPath = random.next() < 0.8 && path.length >= 2;
        const a = onPath ? random.int(path.length) : 0;
        const b = onPath ? a + random.int(path.length - a) : 0;
        const from = onPath ? path[a] : random.pick(ids);
        const to = onPath ? path[b] : random.pick(ids);
        const name = `o${counter++}`;
        op = `compact ${from}..${to}`;
        if (oracle.canOverlay(from, to)) {
          const stored = await session.addCompaction(name, from, to);
          names.set(stored.id, name);
          oracle.addOverlay(name, from, to);
        } else {
          await expect(
            session.addCompaction(name, from, to),
            `seed ${seed}, step ${step} (${op})`
          ).rejects.toThrow();
        }
      } else if (roll < 0.95) {
        const count = 1 + random.int(Math.min(4, ids.length - 1));
        const doomed = new Set<string>();
        while (doomed.size < count) doomed.add(random.pick(ids));
        op = `delete ${[...doomed].join(",")}`;
        oracle.delete([...doomed]);
        await session.deleteMessages([...doomed]);
      } else {
        // Switch the active leaf: append under an older row.
        const id = `r${counter++}`;
        const parent = random.pick(ids);
        op = `leaf ${id} under ${parent}`;
        oracle.append(id, parent);
        await session.appendMessage(text(id), { parentId: parent });
      }
      await check(step, op);
    }
  });
}

describe("Sessions read model against an independent model", () => {
  for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
    it(`agrees with the model on every read (seed ${seed})`, async () => {
      await run(seed, 150);
    }, 120_000);
  }
});
