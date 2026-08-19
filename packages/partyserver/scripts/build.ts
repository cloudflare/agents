import { build } from "tsdown";
import { formatDeclarationFiles } from "../../../scripts/format-declarations";

await build({
  clean: true,
  dts: true,
  target: "es2021",
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
