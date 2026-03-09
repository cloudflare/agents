import { execSync } from "node:child_process";
import { build } from "tsdown";

async function main() {
  await build({
    clean: true,
    dts: true,
    target: "es2021",
    entry: [
      "src/agent.ts",
      "src/think-session.ts",
      "src/session/index.ts",
      "src/extensions/index.ts",
      "src/tools/workspace.ts",
      "src/tools/execute.ts",
      "src/tools/extensions.ts",
      "src/message-builder.ts",
      "src/transport.ts"
    ],
    deps: {
      skipNodeModulesBundle: true,
      neverBundle: ["cloudflare:workers"]
    },
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
