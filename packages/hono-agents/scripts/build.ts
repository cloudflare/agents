import { build } from "vite-plus/pack";
import { formatDeclarationFiles } from "../../../scripts/format-declarations";

async function main() {
  await build({
    clean: true,
    dts: true,
    entry: ["src/*.ts", "src/*.tsx"],
    deps: {
      skipNodeModulesBundle: true,
      neverBundle: ["cloudflare:workers", "cloudflare:email"]
    },
    format: "esm",
    sourcemap: true,
    fixedExtension: false
  });

  // then format the generated .d.ts files
  formatDeclarationFiles();

  process.exit(0);
}

main().catch((err) => {
  // Build failures should fail
  console.error(err);
  process.exit(1);
});
