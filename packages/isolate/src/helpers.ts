import type {
  StateAppliedEditResult,
  StateApplyEditsResult,
  StateApplyEditsOptions,
  StateDirent,
  StateEditInstruction,
  StateEditPlan,
  StateEntryType,
  StateFileReplaceResult,
  StateFileSearchResult,
  StatePlannedEdit,
  StateReplaceInFilesResult,
  StateReplaceInFilesOptions,
  StateReplaceResult,
  StateSearchOptions,
  StateStat,
  StateTextMatch
} from "./backend";
import { StateBatchOperationError } from "./backend";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
const MAX_DIFF_LINES = 10_000;

export function encodeText(value: string): Uint8Array {
  return textEncoder.encode(value);
}

export function decodeText(value: Uint8Array): string {
  return textDecoder.decode(value);
}

export function stateDirent(name: string, type: StateEntryType): StateDirent {
  return { name, type };
}

export function getTypeFromBooleans(
  isFile: boolean,
  isDirectory: boolean,
  isSymbolicLink: boolean
): StateEntryType {
  if (isSymbolicLink) {
    return "symlink";
  }
  if (isDirectory) {
    return "directory";
  }
  if (isFile) {
    return "file";
  }
  throw new Error("Unknown filesystem entry type");
}

export function diffContent(
  current: string,
  next: string,
  labelA: string,
  labelB: string
): string {
  const linesA = current.split("\n").length;
  const linesB = next.split("\n").length;
  if (linesA > MAX_DIFF_LINES || linesB > MAX_DIFF_LINES) {
    throw new Error(
      `EFBIG: content too large for diff (max ${MAX_DIFF_LINES} lines)`
    );
  }

  return unifiedDiff(current, next, labelA, labelB);
}

export function createGlobMatcher(pattern: string): RegExp {
  let i = 0;
  let re = "^";
  while (i < pattern.length) {
    const ch = pattern[i];
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        i += 2;
        if (pattern[i] === "/") {
          re += "(?:.+/)?";
          i++;
        } else {
          re += ".*";
        }
      } else {
        re += "[^/]*";
        i++;
      }
    } else if (ch === "?") {
      re += "[^/]";
      i++;
    } else if (ch === "[") {
      const close = pattern.indexOf("]", i + 1);
      if (close === -1) {
        re += "\\[";
        i++;
      } else {
        re += pattern.slice(i, close + 1);
        i = close + 1;
      }
    } else if (ch === "{") {
      const close = pattern.indexOf("}", i + 1);
      if (close === -1) {
        re += "\\{";
        i++;
      } else {
        const inner = pattern
          .slice(i + 1, close)
          .split(",")
          .join("|");
        re += `(?:${inner})`;
        i = close + 1;
      }
    } else {
      re += ch.replace(/[.+^$|\\()]/g, "\\$&");
      i++;
    }
  }
  re += "$";
  return new RegExp(re);
}

export function sortPaths(paths: string[]): string[] {
  return [...paths].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

export function toStateStat(input: {
  type: StateEntryType;
  size: number;
  mtime: Date;
  mode?: number;
}): StateStat {
  return {
    type: input.type,
    size: input.size,
    mtime: input.mtime,
    mode: input.mode
  };
}

export function parseJsonFileContent(content: string, path: string): unknown {
  try {
    return JSON.parse(content) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid JSON in ${path}: ${message}`);
  }
}

export function stringifyJsonFileContent(
  value: unknown,
  path: string,
  spaces = 2
): string {
  const serialized = JSON.stringify(value, null, spaces);
  if (serialized === undefined) {
    throw new Error(`Unable to serialize JSON for ${path}`);
  }
  return serialized + "\n";
}

export function searchTextContent(
  content: string,
  query: string,
  options: StateSearchOptions = {}
): StateTextMatch[] {
  const matcher = createTextMatcher(query, options);
  const matches: StateTextMatch[] = [];
  const lines = content.split("\n");

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const lineText = lines[lineIndex];
    matcher.lastIndex = 0;

    for (;;) {
      const match = matcher.exec(lineText);
      if (!match) {
        break;
      }

      matches.push({
        line: lineIndex + 1,
        column: match.index + 1,
        match: match[0],
        lineText,
        ...(options.contextBefore
          ? {
              beforeLines: lines.slice(
                Math.max(0, lineIndex - options.contextBefore),
                lineIndex
              )
            }
          : {}),
        ...(options.contextAfter
          ? {
              afterLines: lines.slice(
                lineIndex + 1,
                lineIndex + 1 + options.contextAfter
              )
            }
          : {})
      });

      if (
        options.maxMatches !== undefined &&
        matches.length >= options.maxMatches
      ) {
        return matches;
      }

      if (match[0].length === 0) {
        matcher.lastIndex++;
      }
    }
  }

  return matches;
}

export function replaceTextContent(
  content: string,
  search: string,
  replacement: string,
  options: StateSearchOptions = {}
): StateReplaceResult {
  const matcher = createTextMatcher(search, options);
  let replaced = 0;
  const nextContent = content.replace(matcher, () => {
    replaced++;
    return replacement;
  });

  return {
    replaced,
    content: nextContent
  };
}

export async function collectFileSearchResults(
  paths: string[],
  readFile: (path: string) => Promise<string>,
  search: (content: string) => StateTextMatch[]
): Promise<StateFileSearchResult[]> {
  const results: StateFileSearchResult[] = [];

  for (const path of paths) {
    const content = await readFile(path);
    const matches = search(content);
    if (matches.length > 0) {
      results.push({ path, matches });
    }
  }

  return results;
}

export async function collectFileReplaceResults(
  paths: string[],
  readFile: (path: string) => Promise<string>,
  writeFile: (path: string, content: string) => Promise<void>,
  deleteFile: (path: string) => Promise<void>,
  search: string,
  replacement: string,
  options: StateReplaceInFilesOptions = {}
): Promise<StateReplaceInFilesResult> {
  const files: StateFileReplaceResult[] = [];
  let totalReplacements = 0;
  const appliedSnapshots: Array<{ path: string; previous: string | null }> = [];

  try {
    for (const path of paths) {
      const current = await readFile(path);
      const replaced = replaceTextContent(
        current,
        search,
        replacement,
        options
      );
      if (replaced.replaced === 0) {
        continue;
      }

      if (!options.dryRun) {
        await writeFile(path, replaced.content);
        appliedSnapshots.push({ path, previous: current });
      }

      files.push({
        path,
        replaced: replaced.replaced,
        content: replaced.content,
        diff: diffContent(current, replaced.content, path, path)
      });
      totalReplacements += replaced.replaced;
    }
  } catch (error) {
    const rollback = options.rollbackOnError ?? true;
    const rollbackError = rollback
      ? await rollbackSnapshots(appliedSnapshots, writeFile, deleteFile)
      : undefined;
    throw new StateBatchOperationError({
      operation: "replaceInFiles",
      message: error instanceof Error ? error.message : String(error),
      rolledBack: rollback,
      rollbackError
    });
  }

  return {
    dryRun: options.dryRun ?? false,
    files,
    totalFiles: files.length,
    totalReplacements
  };
}

export async function applyTextEdits(
  edits: { path: string; content: string }[],
  readFileIfExists: (path: string) => Promise<string | null>,
  writeFile: (path: string, content: string) => Promise<void>,
  deleteFile: (path: string) => Promise<void>,
  options: StateApplyEditsOptions = {}
): Promise<StateApplyEditsResult> {
  const results: StateAppliedEditResult[] = [];
  let totalChanged = 0;
  const appliedSnapshots: Array<{ path: string; previous: string | null }> = [];

  try {
    for (const edit of edits) {
      const previous = await readFileIfExists(edit.path);
      const nextContent = edit.content;
      const changed = previous !== nextContent;

      if (changed && !options.dryRun) {
        await writeFile(edit.path, nextContent);
        appliedSnapshots.push({ path: edit.path, previous });
      }

      results.push({
        path: edit.path,
        changed,
        content: nextContent,
        diff: changed
          ? diffContent(previous ?? "", nextContent, edit.path, edit.path)
          : ""
      });

      if (changed) {
        totalChanged++;
      }
    }
  } catch (error) {
    const rollback = options.rollbackOnError ?? true;
    const rollbackError = rollback
      ? await rollbackSnapshots(appliedSnapshots, writeFile, deleteFile)
      : undefined;
    throw new StateBatchOperationError({
      operation: "applyEdits",
      message: error instanceof Error ? error.message : String(error),
      rolledBack: rollback,
      rollbackError
    });
  }

  return {
    dryRun: options.dryRun ?? false,
    edits: results,
    totalChanged
  };
}

export async function planTextEdits(
  instructions: StateEditInstruction[],
  readFileIfExists: (path: string) => Promise<string | null>
): Promise<StateEditPlan> {
  const edits: StatePlannedEdit[] = [];
  let totalChanged = 0;

  for (const instruction of instructions) {
    const previous = await readFileIfExists(instruction.path);
    const content = await plannedContentForInstruction(instruction, previous);
    const changed = previous !== content;

    edits.push({
      instruction,
      path: instruction.path,
      changed,
      content,
      diff: changed
        ? diffContent(
            previous ?? "",
            content,
            instruction.path,
            instruction.path
          )
        : ""
    });

    if (changed) {
      totalChanged++;
    }
  }

  return {
    edits,
    totalChanged,
    totalInstructions: instructions.length
  };
}

export function planToStateEdits(plan: StateEditPlan): Array<{
  path: string;
  content: string;
}> {
  return plan.edits.map((edit) => ({
    path: edit.path,
    content: edit.content
  }));
}

async function rollbackSnapshots(
  snapshots: Array<{ path: string; previous: string | null }>,
  writeFile: (path: string, content: string) => Promise<void>,
  deleteFile: (path: string) => Promise<void>
): Promise<string | undefined> {
  let rollbackError: string | undefined;
  for (let index = snapshots.length - 1; index >= 0; index--) {
    const snapshot = snapshots[index];
    try {
      if (snapshot.previous === null) {
        await deleteFile(snapshot.path);
      } else {
        await writeFile(snapshot.path, snapshot.previous);
      }
    } catch (error) {
      rollbackError = error instanceof Error ? error.message : String(error);
      break;
    }
  }
  return rollbackError;
}

async function plannedContentForInstruction(
  instruction: StateEditInstruction,
  previous: string | null
): Promise<string> {
  if (instruction.kind === "write") {
    return instruction.content;
  }

  if (instruction.kind === "writeJson") {
    return stringifyJsonFileContent(
      instruction.value,
      instruction.path,
      instruction.options?.spaces
    );
  }

  if (previous === null) {
    throw new Error(`ENOENT: no such file: ${instruction.path}`);
  }

  return replaceTextContent(
    previous,
    instruction.search,
    instruction.replacement,
    instruction.options
  ).content;
}

function createTextMatcher(query: string, options: StateSearchOptions): RegExp {
  if (query.length === 0) {
    throw new Error("Search query must not be empty");
  }

  let source = options.regex ? query : escapeRegExp(query);
  if (options.wholeWord) {
    source = `\\b(?:${source})\\b`;
  }

  try {
    return new RegExp(source, options.caseSensitive === false ? "gi" : "g");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid search pattern: ${message}`);
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function unifiedDiff(
  before: string,
  after: string,
  labelBefore: string,
  labelAfter: string,
  contextLines = 3
): string {
  if (before === after) {
    return "";
  }

  const linesBefore = before.split("\n");
  const linesAfter = after.split("\n");
  const edits = myersDiff(linesBefore, linesAfter);
  return formatUnified(
    edits,
    linesBefore,
    linesAfter,
    labelBefore,
    labelAfter,
    contextLines
  );
}

type Edit = {
  type: "keep" | "delete" | "insert";
  lineA: number;
  lineB: number;
};

function myersDiff(before: string[], after: string[]): Edit[] {
  const n = before.length;
  const m = after.length;
  const max = n + m;
  const offset = max;
  const vector = new Int32Array(2 * max + 1);
  vector.fill(-1);
  vector[offset + 1] = 0;

  const trace: Int32Array[] = [];

  outer: for (let d = 0; d <= max; d++) {
    trace.push(vector.slice());
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (
        k === -d ||
        (k !== d && vector[offset + k - 1] < vector[offset + k + 1])
      ) {
        x = vector[offset + k + 1];
      } else {
        x = vector[offset + k - 1] + 1;
      }

      let y = x - k;
      while (x < n && y < m && before[x] === after[y]) {
        x++;
        y++;
      }

      vector[offset + k] = x;
      if (x >= n && y >= m) {
        break outer;
      }
    }
  }

  const edits: Edit[] = [];
  let x = n;
  let y = m;

  for (let d = trace.length - 1; d >= 0; d--) {
    const previous = trace[d];
    const k = x - y;
    let previousK: number;
    if (
      k === -d ||
      (k !== d && previous[offset + k - 1] < previous[offset + k + 1])
    ) {
      previousK = k + 1;
    } else {
      previousK = k - 1;
    }

    const previousX = previous[offset + previousK];
    const previousY = previousX - previousK;

    while (x > previousX && y > previousY) {
      x--;
      y--;
      edits.push({ type: "keep", lineA: x, lineB: y });
    }

    if (d > 0) {
      if (x === previousX) {
        edits.push({ type: "insert", lineA: x, lineB: y - 1 });
        y--;
      } else {
        edits.push({ type: "delete", lineA: x - 1, lineB: y });
        x--;
      }
    }
  }

  edits.reverse();
  return edits;
}

function formatUnified(
  edits: Edit[],
  before: string[],
  after: string[],
  labelBefore: string,
  labelAfter: string,
  contextLines: number
): string {
  const output: string[] = [`--- ${labelBefore}`, `+++ ${labelAfter}`];
  const changes: number[] = [];
  for (let index = 0; index < edits.length; index++) {
    if (edits[index].type !== "keep") {
      changes.push(index);
    }
  }

  if (changes.length === 0) {
    return "";
  }

  let changeIndex = 0;
  while (changeIndex < changes.length) {
    let start = Math.max(0, changes[changeIndex] - contextLines);
    let end = Math.min(edits.length - 1, changes[changeIndex] + contextLines);

    let nextChange = changeIndex + 1;
    while (
      nextChange < changes.length &&
      changes[nextChange] - contextLines <= end + 1
    ) {
      end = Math.min(edits.length - 1, changes[nextChange] + contextLines);
      nextChange++;
    }

    const hunkLines: string[] = [];
    let countBefore = 0;
    let countAfter = 0;
    const startBefore = edits[start].lineA;
    const startAfter = edits[start].lineB;

    for (let idx = start; idx <= end; idx++) {
      const edit = edits[idx];
      if (edit.type === "keep") {
        hunkLines.push(` ${before[edit.lineA]}`);
        countBefore++;
        countAfter++;
      } else if (edit.type === "delete") {
        hunkLines.push(`-${before[edit.lineA]}`);
        countBefore++;
      } else {
        hunkLines.push(`+${after[edit.lineB]}`);
        countAfter++;
      }
    }

    output.push(
      `@@ -${startBefore + 1},${countBefore} +${startAfter + 1},${countAfter} @@`
    );
    output.push(...hunkLines);
    changeIndex = nextChange;
  }

  return output.join("\n");
}
