import { build } from "tsdown";
import { formatDeclarationFiles } from "../../../scripts/format-declarations";

async function main(): Promise<void> {
  await build({
    clean: true,
    dts: true,
    entry: ["src/index.ts"],
    deps: {
      skipNodeModulesBundle: true,
      neverBundle: ["cloudflare:workers"]
    },
    format: "esm",
    sourcemap: true,
    fixedExtension: false
  });

  formatDeclarationFiles();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
