/**
 * The class-only list of the harness score (`harness-class-only.json`).
 *
 * A test is class-only when it reaches its behaviour through something
 * private to the Think class: a row seeded in a private shape, a private
 * method, a private timing seam. It is not counted in the score, it has a
 * successor that asserts the same behaviour through the public API on both
 * configs, and it is deleted with the class code.
 *
 * A mechanics-only test asserts nothing an app can observe (an id format, a
 * skipped write, how a pass keeps its own books), so it has no successor:
 * its row says what private thing it pins, and the score counts it apart.
 *
 * A probe-covered test asserts something an app can observe, but only a
 * platform fault a Workers test cannot raise reaches it (an error shape the
 * runtime throws). Its row names the deployed verify scenario that covers it
 * on both Thinks, and the PR and head that scenario passed on; the score
 * counts it apart too.
 *
 * A ruled-out test asserts something an app could see that a written ruling
 * says the new core will not do, or cannot reach. Its row cites the ruling;
 * the reviewer checks the citation, and that the test asserts that behaviour
 * and nothing else. The score counts it apart, and H11 checks each cited
 * ruling's changeset line against these rows.
 */
import { existsSync, readFileSync } from "node:fs";

/** A class-only test's file and full name. */
type ClassOnlyTest = {
  /** The test's file, relative to `src/tests`. */
  file: string;
  /** The test's full name: "describe > … > name". */
  test: string;
  /** The private row, method or seam the test reaches. */
  reason: string;
};

/** The deployed verify scenario that covers a probe-covered test. */
export type ProbeCoverage = {
  /** The scenario's name in verify's fault suite. */
  scenario: string;
  /** The PR and head it passed on, on both Thinks: "#3474@9c8bf5234". */
  verified: string;
};

/**
 * One class-only test, and either the test that succeeds it, or, for a test
 * that asserts nothing an app can observe, `mechanicsOnly`, or, for one only
 * a platform fault reaches, `probeCovered`.
 */
export type ClassOnlyEntry = ClassOnlyTest &
  (
    | {
        successor: { file: string; test: string };
        mechanicsOnly?: never;
        probeCovered?: never;
        ruledOut?: never;
      }
    | {
        mechanicsOnly: true;
        successor?: never;
        probeCovered?: never;
        ruledOut?: never;
      }
    | {
        probeCovered: ProbeCoverage;
        successor?: never;
        mechanicsOnly?: never;
        ruledOut?: never;
      }
    | {
        /** The written ruling, with who made it and when. */
        ruledOut: string;
        successor?: never;
        mechanicsOnly?: never;
        probeCovered?: never;
      }
  );

/** Whether an entry is mechanics-only: class-only with no successor. */
export function isMechanicsOnly(
  entry: ClassOnlyEntry
): entry is ClassOnlyTest & { mechanicsOnly: true } {
  return entry.mechanicsOnly === true;
}

/** Whether an entry is probe-covered: a deployed scenario, no successor. */
export function isProbeCovered(
  entry: ClassOnlyEntry
): entry is ClassOnlyTest & { probeCovered: ProbeCoverage } {
  return entry.probeCovered !== undefined;
}

/** Whether an entry is ruled out: a written ruling, no successor. */
export function isRuledOut(
  entry: ClassOnlyEntry
): entry is ClassOnlyTest & { ruledOut: string } {
  return entry.ruledOut !== undefined;
}

/** Whether an entry has a successor test. */
function hasSuccessor(
  entry: ClassOnlyEntry
): entry is ClassOnlyTest & { successor: { file: string; test: string } } {
  return entry.successor !== undefined;
}

/** A verify PR and head: "#3474@9c8bf5234". */
const VERIFIED = /^#\d+@[0-9a-f]{7,40}$/;

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
    const entry = (item ?? {}) as {
      file?: unknown;
      test?: unknown;
      reason?: unknown;
      successor?: { file?: unknown; test?: unknown };
      mechanicsOnly?: unknown;
      probeCovered?: { scenario?: unknown; verified?: unknown };
      ruledOut?: unknown;
    };
    const successor = entry.successor ?? {};
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
    if (entry.ruledOut !== undefined) {
      if (
        !isText(entry.ruledOut) ||
        entry.successor !== undefined ||
        entry.mechanicsOnly !== undefined ||
        entry.probeCovered !== undefined
      ) {
        problems.push(
          `${label}: a ruled-out entry has ruledOut: "<the written ruling>", and no successor, mechanicsOnly or probeCovered`
        );
        return;
      }
      entries.push({
        file: entry.file,
        test: entry.test,
        reason: entry.reason,
        ruledOut: entry.ruledOut
      });
      return;
    }
    if (entry.probeCovered !== undefined) {
      const probe = entry.probeCovered ?? {};
      if (
        entry.successor !== undefined ||
        entry.mechanicsOnly !== undefined ||
        entry.ruledOut !== undefined ||
        !isText(probe.scenario) ||
        !isText(probe.verified) ||
        !VERIFIED.test(probe.verified)
      ) {
        problems.push(
          `${label}: a probe-covered entry has probeCovered: { scenario, verified: "#<pr>@<head>" }, and no successor or mechanicsOnly`
        );
        return;
      }
      entries.push({
        file: entry.file,
        test: entry.test,
        reason: entry.reason,
        probeCovered: { scenario: probe.scenario, verified: probe.verified }
      });
      return;
    }
    if (entry.mechanicsOnly !== undefined) {
      if (entry.mechanicsOnly !== true || entry.successor !== undefined) {
        problems.push(
          `${label}: a mechanics-only entry has mechanicsOnly: true and no successor`
        );
        return;
      }
      entries.push({
        file: entry.file,
        test: entry.test,
        reason: entry.reason,
        mechanicsOnly: true
      });
      return;
    }
    if (!isText(successor.file) || !isText(successor.test)) {
      problems.push(
        `${label}: needs a successor (file and test), mechanicsOnly: true, probeCovered or ruledOut`
      );
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

/** The most class-only tests one successor may stand for. */
export const MAX_ENTRIES_PER_SUCCESSOR = 4;

/** How many entries name each successor, by the successor's id. */
export function successorCounts(
  entries: readonly ClassOnlyEntry[]
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const entry of entries) {
    if (!hasSuccessor(entry)) continue;
    const successor = testId(entry.successor.file, entry.successor.test);
    counts.set(successor, (counts.get(successor) ?? 0) + 1);
  }
  return counts;
}

/**
 * What is wrong with the list against a run. A listed test must exist and
 * must not pass on the harness-backed Think (one that passes is not
 * class-only). Its successor must exist, not be class-only itself, pass on
 * the harness-backed Think, exercise Think, and stand for at most
 * {@link MAX_ENTRIES_PER_SUCCESSOR} listed tests. A mechanics-only entry has
 * no successor to check.
 *
 * @param inventory - Ids of every test the suite has (the ordinary
 *   suite's list).
 * @param passed - Ids of the tests that passed in the run against the
 *   harness-backed Think.
 * @param withoutThink - Ids of the tests that passed in the run where
 *   Think cannot be constructed: they do not exercise it, so none can be a
 *   successor.
 */
export function checkClassOnly(
  entries: readonly ClassOnlyEntry[],
  inventory: ReadonlySet<string>,
  passed: ReadonlySet<string>,
  withoutThink: ReadonlySet<string>
): string[] {
  const problems: string[] = [];
  const listed = new Set(
    entries.map((entry) => testId(entry.file, entry.test))
  );
  const seen = new Set<string>();
  for (const entry of entries) {
    const own = testId(entry.file, entry.test);
    if (seen.has(own)) problems.push(`listed twice: ${own}`);
    seen.add(own);
    if (!inventory.has(own)) {
      problems.push(`no such test (delete its row): ${own}`);
    } else if (passed.has(own)) {
      // It reaches nothing the harness-backed Think lacks.
      problems.push(
        `passes on the harness-backed Think, so it is not class-only (delete its row): ${own}`
      );
    }
    if (!hasSuccessor(entry)) continue;
    const successor = testId(entry.successor.file, entry.successor.test);
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
    } else if (withoutThink.has(successor)) {
      problems.push(
        `the successor of ${own} passes without Think, so it does not exercise it: ${successor}`
      );
    }
  }
  for (const [successor, count] of successorCounts(entries)) {
    if (count > MAX_ENTRIES_PER_SUCCESSOR) {
      problems.push(
        `${count} class-only tests name one successor, more than ${MAX_ENTRIES_PER_SUCCESSOR}: ${successor}`
      );
    }
  }
  return problems;
}

/** The class-only table of `harness-compat.md`, or nothing for an empty list. */
export function classOnlyTable(entries: readonly ClassOnlyEntry[]): string {
  if (entries.length === 0) return "";
  const cell = (text: string) => text.replaceAll("|", "\\|");
  const counts = successorCounts(entries);
  const rows = entries.map((entry) =>
    isMechanicsOnly(entry)
      ? `| \`${entry.file}\`: ${cell(entry.test)} | ${cell(entry.reason)} | none: mechanics only | |`
      : isRuledOut(entry)
        ? `| \`${entry.file}\`: ${cell(entry.test)} | ${cell(entry.reason)} | ruled out: ${cell(entry.ruledOut)} | |`
        : isProbeCovered(entry)
          ? `| \`${entry.file}\`: ${cell(entry.test)} | ${cell(entry.reason)} | probe: verify's \`${cell(entry.probeCovered.scenario)}\`, passed on ${cell(entry.probeCovered.verified)} | |`
          : `| \`${entry.file}\`: ${cell(entry.test)} | ${cell(entry.reason)} | \`${entry.successor.file}\`: ${cell(entry.successor.test)} | ${counts.get(testId(entry.successor.file, entry.successor.test))} |`
  );
  return `
## Class-only tests

Each of these reaches its behaviour through something private to the Think
class, so it is not counted above. Its successor asserts the same behaviour
through the public API: it passes here, and on the class in the ordinary
suite (\`pnpm test:workers\`, which CI runs). The list is
\`harness-class-only.json\`; a class-only test is deleted with the class.

A mechanics-only test asserts nothing an app can observe, so it has no
successor; its row says what private thing it pins.

A probe-covered test is reached only by a platform fault a Workers test
cannot raise; its row names the deployed verify scenario that covers it on
both Thinks, and the PR and head it passed on.

A ruled-out test asserts what a written ruling says the new core will not
do or cannot reach; its row cites the ruling.

The last column is how many class-only tests the successor stands for, at
most ${MAX_ENTRIES_PER_SUCCESSOR}.

| Class-only test | What it reaches | Successor | Stands for |
| --- | --- | --- | --- |
${rows.join("\n")}
`;
}
