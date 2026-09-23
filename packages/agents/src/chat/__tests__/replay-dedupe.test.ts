import { describe, expect, it } from "vitest";
import { AppliedChunkLedger, ContinuationReplayFilter } from "../replay-dedupe";

type Frame = {
  body: string;
  continuation?: boolean;
  replay?: boolean;
  replayComplete?: boolean;
  seq?: number;
};

const replay = (seq: number, chunk: Record<string, unknown>): Frame => ({
  body: JSON.stringify(chunk),
  continuation: true,
  replay: true,
  seq
});

describe("AppliedChunkLedger", () => {
  it("flags only continuation replays at or below the applied seq", () => {
    const ledger = new AppliedChunkLedger();
    ledger.record("r1", 2);
    ledger.record("r1", 1);

    expect(ledger.isAppliedReplay("r1", replay(2, {}))).toBe(true);
    expect(ledger.isAppliedReplay("r1", replay(3, {}))).toBe(false);
    expect(
      ledger.isAppliedReplay("r1", { ...replay(0, {}), continuation: false })
    ).toBe(false);
    expect(
      ledger.isAppliedReplay("r1", { ...replay(0, {}), replay: false })
    ).toBe(false);
    expect(ledger.isAppliedReplay("r2", replay(0, {}))).toBe(false);

    ledger.forget("r1");
    expect(ledger.isAppliedReplay("r1", replay(0, {}))).toBe(false);
  });

  it("forgets the least recently applied requests past its capacity", () => {
    const ledger = new AppliedChunkLedger();
    ledger.record("r0", 0);
    for (let i = 1; i <= 32; i++) ledger.record(`r${i}`, 0);
    ledger.record("r1", 1);
    ledger.record("r33", 0);

    expect(ledger.isAppliedReplay("r0", replay(0, {}))).toBe(false);
    expect(ledger.isAppliedReplay("r1", replay(1, {}))).toBe(true);
    expect(ledger.isAppliedReplay("r2", replay(0, {}))).toBe(false);
    expect(ledger.isAppliedReplay("r33", replay(0, {}))).toBe(true);
  });
});

describe("ContinuationReplayFilter", () => {
  const chunks = [
    { type: "start" },
    { type: "text-start", id: "t1" },
    { type: "text-delta", id: "t1", delta: "already " },
    { type: "text-delta", id: "t1", delta: "streamed" },
    { type: "text-delta", id: "t1", delta: " and more" },
    { type: "text-end", id: "t1" }
  ];

  function run(appliedThrough: number): unknown[] {
    const ledger = new AppliedChunkLedger();
    ledger.record("r1", appliedThrough);
    const filter = new ContinuationReplayFilter<Frame>(ledger, "r1");
    const out: unknown[] = [];
    for (const [seq, chunk] of chunks.entries()) {
      for (const frame of filter.frames(replay(seq, chunk))) {
        if (frame.body) out.push(JSON.parse(frame.body));
      }
    }
    return out;
  }

  it("drops applied chunks and re-opens the part they leave open (#1951)", () => {
    expect(run(3)).toEqual([
      { type: "text-start", id: "t1" },
      { type: "text-delta", id: "t1", delta: " and more" },
      { type: "text-end", id: "t1" }
    ]);
  });

  it("re-opens nothing when the applied chunks closed their parts", () => {
    expect(run(5)).toEqual([]);
  });

  it("passes the whole replay through when nothing was applied", () => {
    const ledger = new AppliedChunkLedger();
    const filter = new ContinuationReplayFilter<Frame>(ledger, "r1");
    const out = chunks.flatMap((chunk, seq) =>
      filter.frames(replay(seq, chunk))
    );
    expect(out).toHaveLength(chunks.length);
  });

  it("keeps replay control frames and records live chunks", () => {
    const ledger = new AppliedChunkLedger();
    ledger.record("r1", 1);
    const filter = new ContinuationReplayFilter<Frame>(ledger, "r1");
    const control: Frame = {
      body: "",
      continuation: true,
      replay: true,
      replayComplete: true
    };

    expect(filter.frames(replay(1, chunks[1]))).toEqual([
      { ...replay(1, chunks[1]), body: "" }
    ]);
    expect(filter.frames(control)).toEqual([control]);

    filter.frames({ body: JSON.stringify(chunks[2]), seq: 2 });
    expect(ledger.isAppliedReplay("r1", replay(2, chunks[2]))).toBe(true);
  });
});
