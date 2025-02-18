import { build } from "tsup";
import { execSync } from "child_process";

async function main() {
  await build({
    entry: ["src/*.ts", "src/*.tsx"],
    splitting: true,
    sourcemap: true,
    clean: true,
    external: ["cloudflare:workers"],
    format: "esm",
    dts: true,
  });

  // then run prettier on the generated .d.ts files
  execSync(`prettier --write ./dist/*.d.ts`);

  process.exit(0);
}

main().catch(console.error);
