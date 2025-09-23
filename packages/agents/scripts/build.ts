import { execSync } from "node:child_process";
import { build } from "tsup";

async function main() {
  await build({
    clean: true,
    dts: true,
    entry: [
      "src/*.ts",
      "src/*.tsx",
      "src/mcp/index.ts",
      "src/mcp/client.ts",
      "src/mcp/do-oauth-client-provider.ts",
      "src/mcp/x402.ts",
      "src/observability/index.ts"
    ],
    external: [
      "cloudflare:workers",
      "cloudflare:email",
      "@ai-sdk/react",
      "ai",
      "react",
      "zod",
      "@modelcontextprotocol/sdk",
      "x402"
    ],
    format: "esm",
    sourcemap: true,
    splitting: true
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
