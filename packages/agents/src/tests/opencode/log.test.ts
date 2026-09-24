import { describe, expect, it, vi } from "vitest";
import {
  OpenCodeLogPumps,
  replayOpenCodeLog,
  type OpenCodeLogItem
} from "../../opencode/log";

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

describe("OpenCodeLogPumps", () => {
  it("allows startup to retry after initialization fails", async () => {
    const pumps = new OpenCodeLogPumps();
    let starts = 0;

    await expect(
      pumps.start("session", async () => {
        starts += 1;
        throw new Error("boot failed");
      })
    ).rejects.toThrow("boot failed");
    expect(pumps.has("session")).toBe(false);

    let finish = () => {};
    await expect(
      pumps.start("session", async () => {
        starts += 1;
        return () =>
          new Promise<void>((resolve) => {
            finish = resolve;
          });
      })
    ).resolves.toBe(true);
    expect(pumps.has("session")).toBe(true);
    expect(starts).toBe(2);

    finish();
    await vi.waitFor(() => expect(pumps.has("session")).toBe(false));
  });

  it("starts one source reader per session", async () => {
    const pumps = new OpenCodeLogPumps();
    let starts = 0;
    let finish = () => {};
    const initialize = async () => {
      starts += 1;
      return () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        });
    };

    expect(await pumps.start("session", initialize)).toBe(true);
    expect(await pumps.start("session", initialize)).toBe(false);
    expect(starts).toBe(1);

    pumps.stopAll();
    finish();
  });
});

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
