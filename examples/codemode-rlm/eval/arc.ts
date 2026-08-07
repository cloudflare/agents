export type Grid = number[][];

export type ArcPair = {
  input: Grid;
  output: Grid;
};

export type ArcTask = {
  train: ArcPair[];
  test: ArcPair[];
};

export type ArcTaskSpec = {
  id: string;
  sha256: string;
};

export type ParsedTestAnswer = {
  attempts: Grid[];
  error?: string;
};

export type ParsedArcAnswer = {
  test: ParsedTestAnswer[];
  error?: string;
};

export type ArcScore = {
  correctPairs: number;
  totalPairs: number;
  taskScore: number;
  solved: boolean;
  diagnosticCellAccuracy: number;
  pairResults: Array<{
    correct: boolean;
    matchingAttempt?: number;
    bestCellAccuracy: number;
    error?: string;
  }>;
};

export const ARC_AGI_2_COMMIT = "f3283f727488ad98fe575ea6a5ac981e4a188e49";

export const ARC_AGI_2_REPOSITORY = "https://github.com/arcprize/ARC-AGI-2";

/**
 * A mechanically selected smoke suite spanning five visible-size strata.
 * FAST_ARC_TASK_IDS chooses the small, middle, and largest strata.
 */
export const ARC_TASKS: ArcTaskSpec[] = [
  {
    id: "1818057f",
    sha256: "2372cc93758f9e61fb8b8f65f3ab17fb446d13b223a2402b43a4e6f515ca54a3"
  },
  {
    id: "53fb4810",
    sha256: "be452b59b6ce5e261761fecec7c59d00451bea28a6ee359a7063179803cf8de7"
  },
  {
    id: "38007db0",
    sha256: "c340978756f033487c38421cc80edd3d56d03cd2df007b70767350fc8b447d9d"
  },
  {
    id: "2d0172a1",
    sha256: "881e92e9b8a9e91fc9916cfa08143ca0013fcecc8d90daaad15e7ca1463e2f03"
  },
  {
    id: "62593bfd",
    sha256: "f343e17da1332380b19aec0baa73b721f79ffbc87221671aded2592c0d1edd7d"
  }
];

export const FAST_ARC_TASK_IDS = ["1818057f", "38007db0", "62593bfd"];

/** The three public-evaluation tasks with the fewest agent-visible cells. */
export const MICRO_ARC_TASKS: ArcTaskSpec[] = [
  {
    id: "20270e3b",
    sha256: "e062a7cf0577a3d1a83d2d6f100f126fc5e58b8a5171f3e42d84c3963a512ae2"
  },
  {
    id: "e8686506",
    sha256: "ad102ba0e3662b65ade31f928a8b798d157b1a3a0a56fd89d4d33f56ce9d154c"
  },
  {
    id: "28a6681f",
    sha256: "67509accc3dd81ea6375dc93c0277a27bc01acba93e4900f76b0e238bab7d3d3"
  }
];

export const ARC_TASK_PROMPT = `Solve the ARC-AGI-2 task in the supplied material.

Infer the transformation from every training input/output pair, then apply it independently to each test input. The material contains no test outputs.

Return only one JSON object with this exact shape:
{"test":[{"attempts":[[[0]]]}]}

Requirements:
- Include one test entry per test input, in the same order.
- Each attempts array must contain one or two candidate output grids.
- A grid must be a non-empty rectangular array of integers from 0 through 9.
- Do not include analysis, Markdown fences, labels, or any keys besides test and attempts.`;

export function arcTaskUrl(spec: ArcTaskSpec): string {
  return `https://raw.githubusercontent.com/arcprize/ARC-AGI-2/${ARC_AGI_2_COMMIT}/data/evaluation/${spec.id}.json`;
}

export function isGrid(value: unknown): value is Grid {
  if (!Array.isArray(value) || value.length === 0) return false;
  let width = -1;
  for (const row of value) {
    if (!Array.isArray(row) || row.length === 0) return false;
    if (width < 0) width = row.length;
    if (row.length !== width) return false;
    if (
      !row.every((cell) => Number.isInteger(cell) && cell >= 0 && cell <= 9)
    ) {
      return false;
    }
  }
  return true;
}

export function assertArcTask(value: unknown): asserts value is ArcTask {
  if (!value || typeof value !== "object") {
    throw new Error("ARC task must be an object");
  }
  const task = value as { train?: unknown; test?: unknown };
  for (const [name, pairs] of [
    ["train", task.train],
    ["test", task.test]
  ] as const) {
    if (!Array.isArray(pairs) || pairs.length === 0) {
      throw new Error(`ARC ${name} must be a non-empty array`);
    }
    for (const pair of pairs) {
      if (
        !pair ||
        typeof pair !== "object" ||
        !isGrid((pair as ArcPair).input) ||
        !isGrid((pair as ArcPair).output)
      ) {
        throw new Error(`ARC ${name} contains an invalid pair`);
      }
    }
  }
}

/** Serialize only demonstrations and test inputs; gold outputs never cross this boundary. */
export function visibleTaskMaterial(task: ArcTask): string {
  return JSON.stringify({
    train: task.train,
    test: task.test.map(({ input }) => ({ input }))
  });
}

function answerJson(answer: string): unknown {
  try {
    return JSON.parse(answer.trim());
  } catch {
    throw new Error("answer is not valid JSON");
  }
}

function exactRecord(
  value: unknown,
  keys: string[]
): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

export function parseArcAnswer(
  answer: string,
  testCount: number
): ParsedArcAnswer {
  const empty = (): ParsedArcAnswer => ({
    test: Array.from({ length: testCount }, () => ({ attempts: [] }))
  });
  let value: unknown;
  try {
    value = answerJson(answer);
  } catch (error) {
    return {
      ...empty(),
      error: error instanceof Error ? error.message : String(error)
    };
  }
  if (!exactRecord(value, ["test"]) || !Array.isArray(value.test)) {
    return { ...empty(), error: "answer must contain only a test array" };
  }
  if (value.test.length !== testCount) {
    return {
      ...empty(),
      error: `answer has ${value.test.length} test entries; expected ${testCount}`
    };
  }

  const parsed: ParsedTestAnswer[] = [];
  for (const entry of value.test) {
    if (!exactRecord(entry, ["attempts"]) || !Array.isArray(entry.attempts)) {
      return {
        ...empty(),
        error: "each test entry must contain only attempts"
      };
    }
    if (entry.attempts.length < 1 || entry.attempts.length > 2) {
      return {
        ...empty(),
        error: "attempts must contain one or two grids"
      };
    }
    if (!entry.attempts.every(isGrid)) {
      return { ...empty(), error: "attempts contains an invalid grid" };
    }
    parsed.push({ attempts: entry.attempts });
  }
  return { test: parsed };
}

export function gridsEqual(left: Grid, right: Grid): boolean {
  return (
    left.length === right.length &&
    left.every(
      (row, y) =>
        row.length === right[y]?.length &&
        row.every((cell, x) => cell === right[y][x])
    )
  );
}

export function gridCellAccuracy(candidate: Grid, gold: Grid): number {
  if (
    candidate.length !== gold.length ||
    candidate.some((row, y) => row.length !== gold[y]?.length)
  ) {
    return 0;
  }
  let correct = 0;
  let total = 0;
  for (let y = 0; y < gold.length; y += 1) {
    for (let x = 0; x < gold[y].length; x += 1) {
      total += 1;
      if (candidate[y][x] === gold[y][x]) correct += 1;
    }
  }
  return total === 0 ? 0 : correct / total;
}

export function scoreArcTask(gold: Grid[], parsed: ParsedArcAnswer): ArcScore {
  const pairResults = gold.map((expected, index) => {
    const entry = parsed.test[index] ?? {
      attempts: [],
      error: "missing test entry"
    };
    const matchingAttempt = entry.attempts.findIndex((grid) =>
      gridsEqual(grid, expected)
    );
    return {
      correct: matchingAttempt >= 0,
      ...(matchingAttempt >= 0 ? { matchingAttempt: matchingAttempt + 1 } : {}),
      bestCellAccuracy: Math.max(
        0,
        ...entry.attempts.map((grid) => gridCellAccuracy(grid, expected))
      ),
      ...(entry.error ? { error: entry.error } : {})
    };
  });
  const correctPairs = pairResults.filter(({ correct }) => correct).length;
  return {
    correctPairs,
    totalPairs: gold.length,
    taskScore: gold.length === 0 ? 0 : correctPairs / gold.length,
    solved: gold.length > 0 && correctPairs === gold.length,
    diagnosticCellAccuracy:
      gold.length === 0
        ? 0
        : pairResults.reduce(
            (sum, result) => sum + result.bestCellAccuracy,
            0
          ) / gold.length,
    pairResults
  };
}
