import { cpSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function copyPackageDocs(
  buildScriptUrl: string,
  docsDirectory: string
): void {
  const packageRoot = path.resolve(
    path.dirname(fileURLToPath(buildScriptUrl)),
    ".."
  );
  const destination = path.join(packageRoot, "docs");
  const source = path.resolve(packageRoot, "../../docs", docsDirectory);

  rmSync(destination, { recursive: true, force: true });
  cpSync(source, destination, { recursive: true });
}
