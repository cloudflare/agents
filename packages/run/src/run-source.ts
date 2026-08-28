import { transformCode } from "@cloudflare/worker-bundler/transform";
import { parse as parseModuleProgram } from "acorn";
import { parse as parseImportRecords } from "es-module-lexer/js";
import { RunError } from "./run-error";

/** Number of package-owned wrapper lines above the caller's first line. */
const RUN_WRAPPER_LINE_COUNT = 1;

interface RunSourceLocation {
  readonly line: number;
  readonly column: number;
}

/** Parse the `{ line, column }` diagnostic Acorn and Sucrase errors carry. */
function parseRunCompileLocation(
  cause: unknown
): RunSourceLocation | undefined {
  if (typeof cause !== "object" || cause === null) return undefined;
  try {
    const location: unknown = Reflect.get(cause, "loc");
    if (typeof location !== "object" || location === null) return undefined;
    const line: unknown = Reflect.get(location, "line");
    const column: unknown = Reflect.get(location, "column");
    return typeof line === "number" &&
      Number.isSafeInteger(line) &&
      line >= 1 &&
      typeof column === "number" &&
      Number.isSafeInteger(column) &&
      column >= 0
      ? { line, column }
      : undefined;
  } catch {
    return undefined;
  }
}

function createRunCompileError(cause: unknown): RunError {
  // Parser messages can embed submitted source text (regex bodies,
  // identifier names), so only the fixed text plus an adjusted location may
  // appear, and the raw parser error never becomes a public cause.
  const location = parseRunCompileLocation(cause);
  const sourceLine =
    location === undefined ? 0 : location.line - RUN_WRAPPER_LINE_COUNT;
  const position =
    location !== undefined && sourceLine >= 1
      ? ` (run.js:${sourceLine}:${location.column})`
      : "";
  return new RunError(`Run source could not be compiled${position}.`, {
    code: "RUN_COMPILE_ERROR"
  });
}

/** Count the module line (1-based) that contains the given offset. */
function readRunModuleLine(moduleSource: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset; index += 1) {
    if (moduleSource.charCodeAt(index) === 10) line += 1;
  }
  return line;
}

/**
 * Wrap, transform, and validate submitted source into the `run.js` module.
 *
 * The pipeline strips the guaranteed TypeScript subset through
 * `@cloudflare/worker-bundler/transform`, structurally proves the submitted
 * source stays inside the package-owned async function body, and rejects
 * every import record. All failures throw `RUN_COMPILE_ERROR` before any
 * Dynamic Worker is loaded.
 */
export function createRunSourceModule(
  source: string,
  parameters: string
): string {
  // The submitted source is lexed before wrapping because Sucrase erases
  // `import type` statements instead of failing them: erased imports would
  // otherwise silently vanish rather than reject. Unwrapped, the submitted
  // lines sit at module top level, so static records are visible and record
  // offsets map directly onto submitted line numbers.
  let submittedImports;
  try {
    [submittedImports] = parseImportRecords(source);
  } catch {
    // Lexically broken source falls through to the transform and parse
    // stages, which own malformed-source diagnostics.
    submittedImports = [];
  }
  const [submittedImport] = submittedImports;
  if (submittedImport !== undefined) {
    throw new RunError(
      `Run source must not use imports (run.js:${readRunModuleLine(source, submittedImport.ss)}).`,
      { code: "RUN_COMPILE_ERROR" }
    );
  }

  const prefix = `export default async function __runUser__(${parameters}) {`;
  const wrappedSource = `${prefix}\n${source}\n}`;

  let moduleSource: string;
  try {
    // Synthetic path `run.ts` selects the TypeScript transform; no source
    // maps are generated because the guaranteed subset preserves lines.
    moduleSource = transformCode(wrappedSource, { filePath: "run.ts" }).code;
  } catch (cause: unknown) {
    throw createRunCompileError(cause);
  }

  let program: ReturnType<typeof parseModuleProgram>;
  try {
    program = parseModuleProgram(moduleSource, {
      ecmaVersion: "latest",
      sourceType: "module"
    });
  } catch (cause: unknown) {
    throw createRunCompileError(cause);
  }

  const [statement] = program.body;
  const declaration =
    statement?.type === "ExportDefaultDeclaration"
      ? statement.declaration
      : undefined;
  const runFunction =
    declaration?.type === "FunctionDeclaration" ? declaration : undefined;
  if (
    program.body.length !== 1 ||
    !runFunction?.async ||
    runFunction.generator ||
    runFunction.body.start !== prefix.length - 1 ||
    runFunction.body.end !== moduleSource.length
  ) {
    throw new RunError("Run source must be an async function body.", {
      code: "RUN_COMPILE_ERROR"
    });
  }

  const [firstImport] = parseImportRecords(moduleSource)[0];
  if (firstImport !== undefined) {
    const sourceLine =
      readRunModuleLine(moduleSource, firstImport.ss) - RUN_WRAPPER_LINE_COUNT;
    throw new RunError(
      `Run source must not use imports (run.js:${sourceLine}).`,
      { code: "RUN_COMPILE_ERROR" }
    );
  }

  return moduleSource;
}

const RUN_STACK_FRAME_PATTERN = /^\s+at\s/;
// A rewritable frame locates run.js either bare (`at run.js:3:5`) or as the
// parenthesized suffix (`at outer (run.js:3:5)`). Anchoring the location at
// the frame end — independent of the function display name, which V8 lets
// contain parentheses — drops look-alikes such as `not-run.js:3:5` and data
// URLs embedding `run.js`.
const RUN_JS_PAREN_FRAME_PATTERN = /^(\s+at\s.*\()run\.js:(\d+)(:\d+)?\)$/;
const RUN_JS_BARE_FRAME_PATTERN =
  /^(\s+at\s+(?:async\s+)?)run\.js:(\d+)(:\d+)?$/;

/**
 * Rewrite a child-reported stack onto caller source lines.
 *
 * `run.js` frames lose the one wrapper line so a throw on submitted line 3
 * reports `run.js:3`. Frames for `executor.js`, generated data URLs, and
 * package protocol internals are removed. Non-frame lines — the error name
 * and guest-authored message — pass through unchanged, and columns stay as
 * reported because erased TypeScript makes them best effort.
 */
export function rewriteRunStack(stack: string): string {
  const rewritten: string[] = [];
  for (const line of stack.split("\n")) {
    if (!RUN_STACK_FRAME_PATTERN.test(line)) {
      rewritten.push(line);
      continue;
    }
    const parenFrame = RUN_JS_PAREN_FRAME_PATTERN.exec(line);
    const frame = parenFrame ?? RUN_JS_BARE_FRAME_PATTERN.exec(line);
    if (frame === null) continue;
    const [, prefix = "", frameLine = "", column = ""] = frame;
    const sourceLine = Number(frameLine) - RUN_WRAPPER_LINE_COUNT;
    if (sourceLine < 1) continue;
    const suffix = parenFrame === null ? "" : ")";
    rewritten.push(`${prefix}run.js:${sourceLine}${column}${suffix}`);
  }
  return rewritten.join("\n");
}
