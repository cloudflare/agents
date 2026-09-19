/**
 * The `satisfies TaskMachine` rule.
 *
 * A durable state machine is declared `{ initial, phases, ... } satisfies
 * TaskMachine<State, Mailbox, Result, Seed>` (or `StateMachineDefinition<…>`
 * from `agents/state-machine`). The annotation is what narrows each phase
 * handler's `state` to its own phase, rejects an unknown phase key, and
 * types `ctx`; a map of parameterless handlers that omits it still compiles,
 * with every handler's state read as `never`. The engine's own constraint
 * cannot make that a compile error — every narrower constraint rejects
 * every concrete machine — so this check makes it a lint error instead.
 *
 * Flags every object literal that has both an `initial` and a `phases`
 * property and is not the operand of `satisfies TaskMachine<…>` /
 * `satisfies StateMachineDefinition<…>`, nor the initializer of a binding or
 * property annotated with one of those types.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import fg from "fast-glob";
import ts from "typescript";

// `CompiledTaskFunction` is the engine's own single-phase machine a durable
// function compiles to; it is the one literal that is not authored.
const MACHINE_TYPES = new Set([
  "TaskMachine",
  "StateMachineDefinition",
  "CompiledTaskFunction"
]);
/** A literal on the line after this comment is deliberately unannotated. */
const DISABLE_NEXT_LINE = "check-machine-satisfies-disable-next-line";

function typeNameOf(node: ts.TypeNode | undefined): string | undefined {
  if (!node || !ts.isTypeReferenceNode(node)) return undefined;
  const name = node.typeName;
  return ts.isIdentifier(name) ? name.text : name.right.text;
}

function isMachineType(node: ts.TypeNode | undefined): boolean {
  const name = typeNameOf(node);
  return name !== undefined && MACHINE_TYPES.has(name);
}

function looksLikeMachine(node: ts.ObjectLiteralExpression): boolean {
  let initial = false;
  let phases = false;
  for (const property of node.properties) {
    const name = property.name;
    if (!name || !(ts.isIdentifier(name) || ts.isStringLiteral(name))) continue;
    if (name.text === "initial") initial = true;
    if (name.text === "phases") phases = true;
  }
  return initial && phases;
}

/** The declared type that governs this literal, walking through parentheses and `as const`. */
function annotationFor(node: ts.Node): ts.TypeNode | undefined {
  let current: ts.Node = node;
  for (;;) {
    const parent = current.parent;
    if (!parent) return undefined;
    if (ts.isParenthesizedExpression(parent) || ts.isAsExpression(parent)) {
      current = parent;
      continue;
    }
    if (ts.isSatisfiesExpression(parent)) return parent.type;
    if (ts.isVariableDeclaration(parent) && parent.initializer === current) {
      return parent.type;
    }
    if (ts.isPropertyDeclaration(parent) && parent.initializer === current) {
      return parent.type;
    }
    if (ts.isReturnStatement(parent) || ts.isArrowFunction(parent)) {
      // A function returning a machine: its declared return type governs.
      const fn = ts.findAncestor(parent, ts.isFunctionLike);
      return fn?.type;
    }
    return undefined;
  }
}

export function findUnannotatedMachines(
  fileName: string,
  source: string
): Array<{ line: number; column: number }> {
  const file = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );
  const findings: Array<{ line: number; column: number }> = [];
  const visit = (node: ts.Node): void => {
    if (ts.isObjectLiteralExpression(node) && looksLikeMachine(node)) {
      const start = node.getStart(file);
      const lineStart =
        file.getLineStarts()[
          file.getLineAndCharacterOfPosition(start).line - 1
        ];
      const previousLine =
        lineStart === undefined
          ? ""
          : source.slice(lineStart, source.indexOf("\n", lineStart));
      if (
        !isMachineType(annotationFor(node)) &&
        !previousLine.includes(DISABLE_NEXT_LINE)
      ) {
        const { line, character } = file.getLineAndCharacterOfPosition(
          node.getStart(file)
        );
        findings.push({ line: line + 1, column: character + 1 });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return findings;
}

async function main(): Promise<void> {
  const files = await fg.glob(
    ["packages/*/src/**/*.{ts,tsx}", "examples/**/src/**/*.{ts,tsx}"],
    {
      ignore: [
        "**/node_modules/**",
        "**/dist/**",
        "**/*.d.ts",
        "**/scripts/check-machine-satisfies.ts"
      ]
    }
  );
  let count = 0;
  for (const relative of files) {
    const fileName = resolve(relative);
    if (!existsSync(fileName)) continue;
    const source = readFileSync(fileName, "utf-8");
    if (!source.includes("phases")) continue;
    for (const finding of findUnannotatedMachines(fileName, source)) {
      count += 1;
      console.error(
        `${relative}:${finding.line}:${finding.column}: a machine definition must be declared ` +
          "`satisfies TaskMachine<State, Mailbox, Result, Seed>` (or `StateMachineDefinition<…>`); " +
          "without it every phase handler's state reads as `never`."
      );
    }
  }
  if (count > 0) {
    console.error(`\n${count} machine definition(s) without \`satisfies\`.`);
    process.exit(1);
  }
  console.log("All machine definitions carry `satisfies TaskMachine`.");
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(import.meta.filename)
) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
