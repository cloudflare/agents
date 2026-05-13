import { execFileSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

function findDeclarationFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);
    const stats = statSync(path);

    if (stats.isDirectory()) {
      return findDeclarationFiles(path);
    }

    return path.endsWith(".d.ts") ? [path] : [];
  });
}

export function formatDeclarationFiles(directory = "dist") {
  const declarationFiles = findDeclarationFiles(directory);

  if (declarationFiles.length > 0) {
    execFileSync("oxfmt", ["--write", ...declarationFiles], {
      stdio: "inherit"
    });
  }
}
