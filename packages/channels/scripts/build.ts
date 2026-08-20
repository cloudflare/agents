import { build } from "tsdown";
import { formatDeclarationFiles } from "../../../scripts/format-declarations";

async function main() {
  await build({
    clean: true,
    dts: true,
    target: "es2021",
    entry: {
      index: "src/index.ts",
      "ai-sdk": "src/ai-sdk.ts",
      slack: "src/adapters/slack.ts",
      "tanstack-ai": "src/tanstack-ai.ts",
      voice: "src/adapters/voice.ts"
    },
    deps: {
      skipNodeModulesBundle: true
    },
    format: "esm",
    sourcemap: true,
    fixedExtension: false
  });

  formatDeclarationFiles();

  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
