import { build } from "tsdown";
import { formatDeclarationFiles } from "../../../scripts/format-declarations";

async function main() {
  await build({
    clean: true,
    dts: true,
    entry: [
      "src/index.ts",
      "src/react.tsx",
      "src/types.ts",
      "src/ai-chat-v5-migration.ts"
    ],
    deps: {
      skipNodeModulesBundle: true,
      neverBundle: ["cloudflare:workers", "cloudflare:email"]
    },
    format: "esm",
    sourcemap: true,
    fixedExtension: false
  });

  // then run oxfmt on the generated .d.ts files
  formatDeclarationFiles();

  process.exit(0);
}

main().catch((err) => {
  // Build failures should fail
  console.error(err);
  process.exit(1);
});
