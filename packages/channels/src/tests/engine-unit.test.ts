import type { UIMessageChunk } from "ai";
import { describe, expect, it } from "vitest";
import { isContentChunk } from "../engine/engine";
import { openPartEnds, planResume } from "../engine/resume";
import {
  assertTransition,
  IllegalTurnTransitionError,
  TURN_STATES,
  type TurnState
} from "../engine/turn-state";
import type { JournalEntry } from "../types";

describe("turn state machine", () => {
  const legal: Array<[TurnState, TurnState]> = [
    ["accepted", "streaming"],
    ["accepted", "waiting"],
    ["accepted", "settled"],
    ["streaming", "waiting"],
    ["streaming", "settled"],
    ["waiting", "accepted"],
    // Cancellation (and, later, interaction expiry) settles a durable wait.
    ["waiting", "settled"]
  ];

  it("allows exactly the transitions in the table — no others", () => {
    for (const from of TURN_STATES) {
      for (const to of TURN_STATES) {
        const isLegal = legal.some(([f, t]) => f === from && t === to);
        if (isLegal) {
          expect(() => assertTransition("t", from, to)).not.toThrow();
        } else {
          expect(() => assertTransition("t", from, to)).toThrow(
            IllegalTurnTransitionError
          );
        }
      }
    }
  });
});

function journal(...chunks: UIMessageChunk[]): JournalEntry[] {
  return chunks.map((chunk, seq) => ({ chunk, seq }));
}

describe("openPartEnds", () => {
  it("closes parts a crash left open and nothing else", () => {
    const ends = openPartEnds(
      journal(
        { id: "a", type: "text-start" },
        { delta: "done", id: "a", type: "text-delta" },
        { id: "a", type: "text-end" },
        { id: "b", type: "reasoning-start" },
        { delta: "thinking", id: "b", type: "reasoning-delta" }
      )
    );
    expect(ends).toEqual([{ id: "b", type: "reasoning-end" }]);
  });

  it("returns nothing for a well-formed journal", () => {
    expect(
      openPartEnds(
        journal({ id: "a", type: "text-start" }, { id: "a", type: "text-end" })
      )
    ).toEqual([]);
  });
});

describe("planResume", () => {
  it("swallows the re-emitted overlap and passes fresh content, trimming the straddling delta", () => {
    const plan = planResume(
      journal(
        { id: "p1", type: "text-start" },
        { delta: "Hello ", id: "p1", type: "text-delta" },
        { id: "p1", type: "text-end" }
      )
    );

    const out: UIMessageChunk[] = [];
    out.push(...plan.filter({ id: "p2", type: "text-start" }));
    out.push(...plan.filter({ delta: "Hell", id: "p2", type: "text-delta" }));
    out.push(...plan.filter({ delta: "o wo", id: "p2", type: "text-delta" }));
    out.push(...plan.filter({ delta: "rld", id: "p2", type: "text-delta" }));
    out.push(...plan.filter({ id: "p2", type: "text-end" }));

    expect(out).toEqual([
      // The straddling delta gets a synthesized opening, under an id
      // aliased to this resume so it cannot collide with journaled parts.
      { id: "p2~r3", type: "text-start" },
      { delta: "wo", id: "p2~r3", type: "text-delta" },
      { delta: "rld", id: "p2~r3", type: "text-delta" },
      { id: "p2~r3", type: "text-end" }
    ]);
  });

  it("drops end frames of fully swallowed parts", () => {
    const plan = planResume(
      journal({ delta: "complete", id: "p1", type: "text-delta" })
    );
    const out = [
      ...plan.filter({ id: "p2", type: "text-start" }),
      ...plan.filter({ delta: "complete", id: "p2", type: "text-delta" }),
      ...plan.filter({ id: "p2", type: "text-end" })
    ];
    expect(out).toEqual([]);
  });

  it("dedupes re-emitted tool events by type and call id", () => {
    const plan = planResume(
      journal({
        input: { q: 1 },
        toolCallId: "call-1",
        toolName: "search",
        type: "tool-input-available"
      } as UIMessageChunk)
    );
    const replayedInput = plan.filter({
      input: { q: 1 },
      toolCallId: "call-1",
      toolName: "search",
      type: "tool-input-available"
    } as UIMessageChunk);
    const freshOutput = plan.filter({
      output: { hits: 3 },
      toolCallId: "call-1",
      type: "tool-output-available"
    } as UIMessageChunk);

    expect(replayedInput).toEqual([]);
    expect(freshOutput).toHaveLength(1);
  });

  it("tracks text and reasoning overlaps independently", () => {
    const plan = planResume(
      journal(
        { delta: "thought", id: "r1", type: "reasoning-delta" },
        { delta: "Hi", id: "p1", type: "text-delta" }
      )
    );
    const out = [
      ...plan.filter({ delta: "thought", id: "r2", type: "reasoning-delta" }),
      ...plan.filter({ delta: "Hi", id: "p2", type: "text-delta" }),
      ...plan.filter({ delta: " there", id: "p2", type: "text-delta" })
    ];
    expect(out).toEqual([
      { id: "p2~r2", type: "text-start" },
      { delta: " there", id: "p2~r2", type: "text-delta" }
    ]);
  });
});

describe("planResume content-chunk dedupe", () => {
  it("drops replayed data/file chunks the journal already holds, once each", () => {
    const dataChunk = {
      data: { temp: 21 },
      type: "data-weather"
    } as unknown as UIMessageChunk;
    const plan = planResume(journal(dataChunk));

    expect(plan.filter(dataChunk)).toEqual([]);
    const fresh = {
      data: { temp: 25 },
      type: "data-weather"
    } as unknown as UIMessageChunk;
    expect(plan.filter(fresh)).toEqual([fresh]);
    // …and the freshly passed chunk itself dedupes on a later replay.
    expect(plan.filter(fresh)).toEqual([]);
  });
});

describe("isContentChunk", () => {
  it("counts only chunks that put content in front of a user", () => {
    expect(isContentChunk({ delta: "x", id: "a", type: "text-delta" })).toBe(
      true
    );
    expect(isContentChunk({ delta: "", id: "a", type: "text-delta" })).toBe(
      false
    );
    expect(isContentChunk({ id: "a", type: "text-start" })).toBe(false);
    expect(isContentChunk({ id: "a", type: "text-end" })).toBe(false);
    expect(
      isContentChunk({
        input: {},
        toolCallId: "c",
        toolName: "t",
        type: "tool-input-available"
      } as UIMessageChunk)
    ).toBe(true);
  });
});
