import { build } from "tsdown";
import { globSync } from "glob";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { formatDeclarationFiles } from "../../../scripts/format-declarations";

const entries = [
  "src/*.ts",
  "src/*.tsx",
  "src/skills/index.ts",
  "src/skills/compile.ts",
  "src/chat/index.ts",
  "src/chat/react.tsx",
  "src/chat-sdk/index.ts",
  "src/cli/index.ts",
  "src/mcp/index.ts",
  "src/mcp/client.ts",
  "src/mcp/do-oauth-client-provider.ts",
  "src/mcp/x402.ts",
  "src/observability/index.ts",
  "src/codemode/ai.ts",
  "src/experimental/memory/session/index.ts",
  "src/experimental/memory/utils/index.ts",
  "src/browser/index.ts",
  "src/browser/ai.ts",
  "src/browser/tanstack-ai.ts",
  "src/experimental/webmcp.ts"
];

for (const entry of entries) {
  // verify that the entry exists
  // if it's a glob pattern, verify that at least one file matches
  if (entry.includes("*")) {
    const files = globSync(entry);
    if (files.length === 0) {
      throw new Error(`No files match glob pattern ${entry}`);
    }
  } else {
    if (!existsSync(entry)) {
      throw new Error(`Entry ${entry} does not exist`);
    }
  }
}

// The `agents:skills` virtual-module types live in a standalone ambient
// declaration (skills-module.d.ts) so they survive d.ts bundling. Prepend a
// reference to the main entry so importing `agents` (directly or transitively
// via @cloudflare/think / @cloudflare/ai-chat) brings them into scope without a
// per-project shim.
function injectSkillsTypeReference(): void {
  const dtsPath = "dist/index.d.ts";
  const directive = '/// <reference path="../skills-module.d.ts" />\n';
  const current = readFileSync(dtsPath, "utf8");
  if (!current.startsWith(directive)) {
    writeFileSync(dtsPath, directive + current);
  }
}

async function main() {
  await build({
    clean: true,
    dts: true,
    target: "es2021",
    entry: entries,
    deps: {
      skipNodeModulesBundle: true,
      neverBundle: ["cloudflare:workers", "cloudflare:email"]
    },
    format: "esm",
    sourcemap: true,
    fixedExtension: false
  });

  // then run oxfmt on the generated .d.ts files
  formatDeclarationFiles();

  injectSkillsTypeReference();

  process.exit(0);
}

main().catch((err) => {
  // Build failures should fail
  console.error(err);
  process.exit(1);
});
