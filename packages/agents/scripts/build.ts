import { execSync } from "node:child_process";
import { build } from "tsdown";

async function main() {
  await build({
    clean: true,
    dts: true,
    entry: [
      "src/*.ts",
      "src/*.tsx",
      "src/cli/index.ts",
      "src/mcp/index.ts",
      "src/mcp/client.ts",
      "src/mcp/do-oauth-client-provider.ts",
      "src/mcp/x402.ts",
      "src/observability/index.ts",
      "src/codemode/ai.ts"
    ],
    skipNodeModulesBundle: true,
    external: ["cloudflare:workers", "cloudflare:email"],
    format: "esm",
    sourcemap: true,
    fixedExtension: false
  });

  // then run prettier on the generated .d.ts files
  execSync("prettier --write ./dist/*.d.ts");

  process.exit(0);
}

main().catch((err) => {
  // Build failures should fail
  console.error(err);
  process.exit(1);
});
