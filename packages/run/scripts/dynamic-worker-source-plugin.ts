import { readFile } from "node:fs/promises";
import ts from "typescript";

const DYNAMIC_WORKER_SOURCE_QUERY = "?dynamic-worker-source";

interface DynamicWorkerSourcePlugin {
  readonly name: string;
  readonly enforce: "pre";
  load(id: string): Promise<string | null>;
}

/** Compile a checked TypeScript module and expose its JavaScript as a string. */
export function dynamicWorkerSourcePlugin(): DynamicWorkerSourcePlugin {
  return {
    name: "run-dynamic-worker-source",
    enforce: "pre",
    async load(id) {
      if (!id.endsWith(DYNAMIC_WORKER_SOURCE_QUERY)) return null;

      const filePath = id.slice(0, -DYNAMIC_WORKER_SOURCE_QUERY.length);
      const source = await readFile(filePath, "utf8");
      const transformed = ts.transpileModule(source, {
        fileName: filePath,
        reportDiagnostics: true,
        compilerOptions: {
          module: ts.ModuleKind.ES2022,
          target: ts.ScriptTarget.ES2021
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
      return `export default ${JSON.stringify(transformed.outputText)};`;
    }
  };
}
