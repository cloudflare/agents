import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import ts from "typescript";

const DYNAMIC_WORKER_SOURCE_QUERY = "?dynamic-worker-source";

interface DynamicWorkerSourcePlugin {
  readonly name: string;
  readonly enforce: "pre";
  load(id: string): Promise<string | null>;
}

async function transpileDynamicWorkerModule(filePath: string): Promise<string> {
  const source = await readFile(filePath, "utf8");
  const transformed = ts.transpileModule(source, {
    fileName: filePath,
    reportDiagnostics: true,
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      // ES2022 emits native class fields with define semantics. Lowering them
      // would route field initialization through the mutable global
      // Object.defineProperty, which guest code can replace.
      target: ts.ScriptTarget.ES2022,
      useDefineForClassFields: true
    }
  });
  const diagnostic = transformed.diagnostics?.find(
    ({ category }) => category === ts.DiagnosticCategory.Error
  );
  if (diagnostic) {
    throw new Error(
      ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")
    );
  }
  return transformed.outputText;
}

function removeStatements(
  sourceFile: ts.SourceFile,
  statements: readonly ts.Statement[]
): string {
  let text = sourceFile.text;
  const descending = [...statements].sort(
    (left, right) => right.getStart(sourceFile) - left.getStart(sourceFile)
  );
  for (const statement of descending) {
    text =
      text.slice(0, statement.getStart(sourceFile)) + text.slice(statement.end);
  }
  return text;
}

/**
 * Convert one transpiled dependency module into a scope-isolated segment that
 * binds exactly its named exports in the surrounding generated Worker source.
 */
function createEmbeddedDependencySegment(
  filePath: string,
  transpiled: string
): string {
  const sourceFile = ts.createSourceFile(
    filePath,
    transpiled,
    ts.ScriptTarget.ES2022,
    true
  );
  const exportedNames: string[] = [];
  const exportStatements: ts.Statement[] = [];
  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement)) {
      throw new Error(
        `Embedded dependency ${filePath} must not import other modules.`
      );
    }
    if (ts.isExportDeclaration(statement)) {
      if (
        statement.moduleSpecifier !== undefined ||
        statement.exportClause === undefined ||
        !ts.isNamedExports(statement.exportClause)
      ) {
        throw new Error(
          `Embedded dependency ${filePath} must use one named export list.`
        );
      }
      for (const specifier of statement.exportClause.elements) {
        exportedNames.push(specifier.name.text);
      }
      exportStatements.push(statement);
      continue;
    }
    if (
      ts.isExportAssignment(statement) ||
      (ts.canHaveModifiers(statement) &&
        ts
          .getModifiers(statement)
          ?.some(
            (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword
          ) === true)
    ) {
      throw new Error(
        `Embedded dependency ${filePath} must export through one named export list.`
      );
    }
  }
  if (exportedNames.length === 0) {
    throw new Error(`Embedded dependency ${filePath} exports nothing.`);
  }

  const names = exportedNames.join(", ");
  const body = removeStatements(sourceFile, exportStatements);
  return `const { ${names} } = (() => {\n${body}\nreturn { ${names} };\n})();\n`;
}

/**
 * Compile a checked TypeScript module into one self-contained generated
 * Worker source string, inlining its relative imports as isolated segments.
 */
export function dynamicWorkerSourcePlugin(): DynamicWorkerSourcePlugin {
  return {
    name: "run-dynamic-worker-source",
    enforce: "pre",
    async load(id) {
      if (!id.endsWith(DYNAMIC_WORKER_SOURCE_QUERY)) return null;

      const filePath = id.slice(0, -DYNAMIC_WORKER_SOURCE_QUERY.length);
      const transpiled = await transpileDynamicWorkerModule(filePath);
      const sourceFile = ts.createSourceFile(
        filePath,
        transpiled,
        ts.ScriptTarget.ES2022,
        true
      );

      const segments: string[] = [];
      const inlinedImports: ts.Statement[] = [];
      for (const statement of sourceFile.statements) {
        if (!ts.isImportDeclaration(statement)) continue;
        const specifier = statement.moduleSpecifier;
        if (
          !ts.isStringLiteral(specifier) ||
          !specifier.text.startsWith("./")
        ) {
          continue;
        }
        const dependencyPath = join(
          dirname(filePath),
          `${specifier.text.slice(2)}.ts`
        );
        segments.push(
          createEmbeddedDependencySegment(
            dependencyPath,
            await transpileDynamicWorkerModule(dependencyPath)
          )
        );
        inlinedImports.push(statement);
      }

      const composed =
        segments.join("") + removeStatements(sourceFile, inlinedImports);
      return `export default ${JSON.stringify(composed)};`;
    }
  };
}
