import { readFileSync } from "node:fs";
import { build } from "tsdown";
import { formatDeclarationFiles } from "../../../scripts/format-declarations";

function assertFrameworkFreeRootEntry() {
  const optionalFrameworkPeers = ["ai", "zod", "@tanstack/ai"];

  for (const file of ["dist/index.js", "dist/index.d.ts"]) {
    const rootEntry = readFileSync(file, "utf8");
    const frameworkImport = optionalFrameworkPeers.find(
      (peer) =>
        rootEntry.includes(`from "${peer}"`) ||
        rootEntry.includes(`from '${peer}'`) ||
        rootEntry.includes(`import("${peer}")`) ||
        rootEntry.includes(`import('${peer}')`)
    );

    if (frameworkImport) {
      throw new Error(
        `${file} must not import optional framework peer "${frameworkImport}"`
      );
    }
  }
}

async function main() {
  await build({
    clean: true,
    dts: true,
    entry: [
      "src/index.ts",
      "src/ai.ts",
      "src/mcp.ts",
      "src/tanstack-ai.ts",
      "src/browser.ts",
      "src/vite.ts"
    ],
    deps: {
      skipNodeModulesBundle: true,
      neverBundle: ["cloudflare:workers"]
    },
    format: "esm",
    sourcemap: true,
    fixedExtension: false
  });

  assertFrameworkFreeRootEntry();

  // then run oxfmt on the generated .d.ts files
  formatDeclarationFiles();

  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
