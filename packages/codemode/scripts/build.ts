import { execSync } from "node:child_process";
import { build } from "tsdown";

async function main() {
  await build({
    clean: true,
    dts: true,
    entry: ["src/index.ts", "src/ai.ts"],
    skipNodeModulesBundle: true,
    external: ["cloudflare:workers"],
    format: "esm",
    sourcemap: true,
    fixedExtension: false
  });

  // then run oxfmt on the generated .d.ts files
  execSync("oxfmt --write ./dist/*.d.ts");

  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
