import { execSync } from "node:child_process";
import { build } from "tsdown";

async function main() {
  await build({
    clean: true,
    dts: true,
    target: "es2021",
    entry: [
      "src/*.ts",
      "src/*.tsx",
      "src/chat/index.ts",
      "src/cli/index.ts",
      "src/mcp/index.ts",
      "src/mcp/client.ts",
      "src/mcp/do-oauth-client-provider.ts",
      "src/mcp/x402.ts",
      "src/observability/index.ts",
      "src/codemode/ai.ts",
      "src/experimental/forever.ts",
      "src/experimental/memory/session/index.ts",
      "src/experimental/memory/utils/index.ts",
      "src/browser/index.ts",
      "src/browser/ai.ts",
      "src/browser/tanstack-ai.ts"
    ],
    deps: {
      skipNodeModulesBundle: true,
      neverBundle: ["cloudflare:workers", "cloudflare:email"]
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
