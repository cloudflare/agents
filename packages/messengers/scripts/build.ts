import { execSync } from "node:child_process";
import { build } from "tsdown";

async function main() {
  await build({
    clean: true,
    dts: true,
    entry: [
      "src/index.ts",
      "src/adapters/slack/index.ts",
      "src/adapters/telegram/index.ts",
      "src/adapters/google-chat/index.ts"
    ],
    skipNodeModulesBundle: true,
    external: ["cloudflare:workers"],
    format: "esm",
    sourcemap: true,
    fixedExtension: false
  });

  execSync("oxfmt --write ./dist/*.d.ts ./dist/**/*.d.ts", {
    stdio: "inherit"
  });

  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
