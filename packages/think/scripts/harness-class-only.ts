/**
 * The class-only list of the harness score (`harness-class-only.json`).
 *
 * A test is class-only when it reaches its behaviour through something
 * private to the Think class: a row seeded in a private shape, a private
 * method, a private timing seam. It is not counted in the score, it has a
 * successor that asserts the same behaviour through the public API on both
 * configs, and it is deleted with the class code.
 */
import { existsSync, readFileSync } from "node:fs";

/** One class-only test and the test that succeeds it. */
export type ClassOnlyEntry = {
  /** The test's file, relative to `src/tests`. */
  file: string;
  /** The test's full name: "describe > … > name". */
  test: string;
  /** The private row, method or seam the test reaches. */
  reason: string;
  successor: { file: string; test: string };
};

/** A test's id in the score: its file and full name. */
export function testId(file: string, test: string): string {
  return `${file} > ${test}`;
}

const isText = (value: unknown): value is string =>
  typeof value === "string" && value.trim() !== "";

/**
 * Read the class-only list.
 *
 * @returns The entries, and what is wrong with the file's shape. A missing
 *   file is an empty list.
 */
export function readClassOnly(file: string): {
  entries: ClassOnlyEntry[];
  problems: string[];
} {
  if (!existsSync(file)) return { entries: [], problems: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    return { entries: [], problems: [`${file} is not JSON: ${String(error)}`] };
  }
  if (!Array.isArray(parsed)) {
    return { entries: [], problems: [`${file} must hold a list`] };
  }
  const entries: ClassOnlyEntry[] = [];
  const problems: string[] = [];
  parsed.forEach((item: unknown, index) => {
    const entry = (item ?? {}) as Partial<ClassOnlyEntry>;
    const successor = (entry.successor ?? {}) as Partial<
      ClassOnlyEntry["successor"]
    >;
    const label = isText(entry.test) ? `"${entry.test}"` : `entry ${index + 1}`;
    if (!isText(entry.file) || !isText(entry.test)) {
      problems.push(`${label}: needs a file and a test`);
      return;
    }
    if (!isText(entry.reason)) {
      problems.push(
        `${label}: needs a reason (the private row, method or seam)`
      );
      return;
    }
    if (!isText(successor.file) || !isText(successor.test)) {
      problems.push(`${label}: needs a successor (file and test)`);
      return;
    }
    entries.push({
      file: entry.file,
      test: entry.test,
      reason: entry.reason,
      successor: { file: successor.file, test: successor.test }
    });
  });
  return { entries, problems };
}

/**
 * What is wrong with the list against a run.
 *
 * @param inventory - Ids of every test the suite has.
 * @param passed - Ids of the tests that passed on the harness-backed Think.
 */
export function checkClassOnly(
  entries: readonly ClassOnlyEntry[],
  inventory: ReadonlySet<string>,
  passed: ReadonlySet<string>
): string[] {
  const problems: string[] = [];
  const listed = new Set(
    entries.map((entry) => testId(entry.file, entry.test))
  );
  const seen = new Set<string>();
  for (const entry of entries) {
    const own = testId(entry.file, entry.test);
    const successor = testId(entry.successor.file, entry.successor.test);
    if (seen.has(own)) problems.push(`listed twice: ${own}`);
    seen.add(own);
    if (!inventory.has(own)) {
      problems.push(`no such test (delete its row): ${own}`);
    }
    if (listed.has(successor)) {
      problems.push(
        `the successor of ${own} is class-only itself: ${successor}`
      );
    } else if (!inventory.has(successor)) {
      problems.push(`the successor of ${own} does not exist: ${successor}`);
    } else if (!passed.has(successor)) {
      problems.push(
        `the successor of ${own} does not pass on the harness-backed Think: ${successor}`
      );
    }
  }
  return problems;
}

/** The class-only table of `harness-compat.md`, or nothing for an empty list. */
export function classOnlyTable(entries: readonly ClassOnlyEntry[]): string {
  if (entries.length === 0) return "";
  const cell = (text: string) => text.replaceAll("|", "\\|");
  const rows = entries.map(
    (entry) =>
      `| \`${entry.file}\`: ${cell(entry.test)} | ${cell(entry.reason)} | \`${entry.successor.file}\`: ${cell(entry.successor.test)} |`
  );
  return `
## Class-only tests

Each of these reaches its behaviour through something private to the Think
class, so it is not counted above. Its successor asserts the same behaviour
through the public API: it passes here, and on the class in the ordinary
suite (\`pnpm test:workers\`, which CI runs). The list is
\`harness-class-only.json\`; a class-only test is deleted with the class.

| Class-only test | What it reaches | Successor |
| --- | --- | --- |
${rows.join("\n")}
`;
}
