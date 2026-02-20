import { build } from "tsdown";
import { execSync } from "child_process";

async function main() {
  await build({
    clean: true,
    dts: true,
    entry: ["src/index.ts", "src/ai.ts"],
    external: ["cloudflare:workers", "agents"],
    format: "esm",
    sourcemap: true
  });

  // then run oxfmt on the generated .d.ts files
  execSync("oxfmt --write './dist/*.d.{ts,mts}'");

  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
