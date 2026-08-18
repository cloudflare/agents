import { build } from "tsdown";
import { copyPackageDocs } from "../../../scripts/copy-package-docs";
import { formatDeclarationFiles } from "../../../scripts/format-declarations";

async function main() {
  await build({
    clean: true,
    dts: true,
    target: "es2021",
    entry: [
      "src/index.ts",
      "src/ai-sdk.ts",
      "src/alarm-coordinator.ts",
      "src/tanstack-ai.ts"
    ],
    deps: {
      skipNodeModulesBundle: true
    },
    format: "esm",
    sourcemap: true,
    fixedExtension: false
  });

  formatDeclarationFiles();
  copyPackageDocs(import.meta.url, "channels");

  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
