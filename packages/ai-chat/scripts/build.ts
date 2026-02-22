import { execSync } from "node:child_process";
import { build } from "tsdown";

async function main() {
  await build({
    clean: true,
    dts: true,
    entry: [
      "src/index.ts",
      "src/react.tsx",
      "src/types.ts",
      "src/ai-chat-v5-migration.ts",
      "src/experimental/forever.ts"
    ],
    skipNodeModulesBundle: true,
    external: ["cloudflare:workers", "cloudflare:email"],
    format: "esm",
    sourcemap: true,
    fixedExtension: false
  });

  // then run oxfmt on the generated .d.ts files
  execSync("oxfmt --write ./dist/*.d.ts");

  process.exit(0);
}

main().catch((err) => {
  // Build failures should fail
  console.error(err);
  process.exit(1);
});
