import { build } from "tsdown";
import { formatDeclarationFiles } from "../../../scripts/format-declarations";
import { dynamicWorkerSourcePlugin } from "./dynamic-worker-source-plugin";

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
    fixedExtension: false,
    plugins: [dynamicWorkerSourcePlugin()]
  });

  formatDeclarationFiles();
}

main().catch((cause: unknown) => {
  console.error(cause);
  process.exit(1);
});
