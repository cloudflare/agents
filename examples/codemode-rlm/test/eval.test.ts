import { describe, expect, it } from "vitest";
import {
  parseArcAnswer,
  scoreArcTask,
  visibleTaskMaterial,
  type ArcTask
} from "../eval/arc";

const task: ArcTask = {
  train: [
    {
      input: [
        [0, 1],
        [1, 0]
      ],
      output: [
        [1, 0],
        [0, 1]
      ]
    }
  ],
  test: [
    {
      input: [[0, 1]],
      output: [[1, 0]]
    }
  ]
};

describe("ARC smoke scorer", () => {
  it("keeps gold test outputs outside agent-visible material", () => {
    const visible = JSON.parse(visibleTaskMaterial(task)) as ArcTask;
    expect(visible.train).toEqual(task.train);
    expect(visible.test).toEqual([{ input: [[0, 1]] }]);
    expect(visible.test[0]).not.toHaveProperty("output");
  });

  it("accepts one or two valid attempts and scores exact equality", () => {
    const parsed = parseArcAnswer(
      JSON.stringify({
        test: [
          {
            attempts: [[[0, 1]], [[1, 0]]]
          }
        ]
      }),
      1
    );
    expect(parsed.error).toBeUndefined();
    expect(scoreArcTask([task.test[0].output], parsed)).toMatchObject({
      correctPairs: 1,
      totalPairs: 1,
      taskScore: 1,
      solved: true,
      pairResults: [{ correct: true, matchingAttempt: 2 }]
    });
  });

  it("does not award exact or cell credit to a wrong-shaped grid", () => {
    const parsed = parseArcAnswer('{"test":[{"attempts":[[[1],[0]]]}]}', 1);
    expect(scoreArcTask([task.test[0].output], parsed)).toMatchObject({
      correctPairs: 0,
      diagnosticCellAccuracy: 0,
      solved: false
    });
  });

  it("turns malformed output into a zero-score parse result", () => {
    const parsed = parseArcAnswer("not JSON", 1);
    expect(parsed.error).toBe("answer is not valid JSON");
    expect(parsed.test).toEqual([{ attempts: [] }]);
    expect(scoreArcTask([task.test[0].output], parsed).taskScore).toBe(0);
  });

  it("gives zero credit when any attempt or schema field is invalid", () => {
    const invalidAttempt = parseArcAnswer(
      '{"test":[{"attempts":[[[1,0]],"not a grid"]}]}',
      1
    );
    expect(invalidAttempt.error).toMatch(/invalid grid/);
    expect(scoreArcTask([task.test[0].output], invalidAttempt)).toMatchObject({
      correctPairs: 0,
      taskScore: 0
    });

    for (const answer of [
      'analysis {"test":[{"attempts":[[[1,0]]]}]}',
      '```json\n{"test":[{"attempts":[[[1,0]]]}]}\n```',
      '{"test":[{"attempts":[[[1,0]]]}],"extra":true}',
      '{"test":[{"attempts":[[[1,0]]],"extra":true}]}'
    ]) {
      const parsed = parseArcAnswer(answer, 1);
      expect(parsed.error).toBeDefined();
      expect(scoreArcTask([task.test[0].output], parsed).taskScore).toBe(0);
    }
  });
});
