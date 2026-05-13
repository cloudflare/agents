import { build } from "tsdown";
import { formatDeclarationFiles } from "../../../scripts/format-declarations";

async function main() {
  await build({
    clean: true,
    dts: true,
    entry: ["src/index.ts", "src/workers.ts", "src/git/index.ts"],
    deps: {
      skipNodeModulesBundle: true,
      neverBundle: ["cloudflare:workers"]
    },
    format: "esm",
    sourcemap: true,
    fixedExtension: false
  });

  formatDeclarationFiles();

  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
