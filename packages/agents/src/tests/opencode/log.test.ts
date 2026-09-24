import { describe, expect, it } from "vitest";
import { replayOpenCodeLog, type OpenCodeLogItem } from "../../opencode/log";

function event(seq: number): OpenCodeLogItem {
  return {
    type: "session.step.ended",
    durable: { aggregateID: "session", seq, version: 1 },
    data: { sessionID: "session" }
  };
}

async function* items(values: readonly OpenCodeLogItem[]) {
  for (const value of values) yield value;
}

describe("replayOpenCodeLog", () => {
  it("advances its cursor only after projection succeeds", async () => {
    let cursor = 2;
    const projected: number[] = [];

    await expect(
      replayOpenCodeLog({
        after: cursor,
        source: items([event(3), event(4)]),
        project: async (item) => {
          const seq = item.durable?.seq ?? -1;
          if (seq === 4) throw new Error("projection failed");
          projected.push(seq);
        },
        save: async (seq) => {
          cursor = seq;
        }
      })
    ).rejects.toThrow("projection failed");

    expect(projected).toEqual([3]);
    expect(cursor).toBe(3);
  });

  it("ignores sync markers and repeated durable sequences", async () => {
    let cursor = 3;
    const projected: number[] = [];

    await replayOpenCodeLog({
      after: cursor,
      source: items([
        event(3),
        {
          type: "log.synced",
          aggregateID: "session",
          seq: 3
        },
        event(4)
      ]),
      project: async (item) => {
        projected.push(item.durable?.seq ?? -1);
      },
      save: async (seq) => {
        cursor = seq;
      }
    });

    expect(projected).toEqual([4]);
    expect(cursor).toBe(4);
  });
});
