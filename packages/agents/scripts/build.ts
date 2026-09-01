import { build } from "tsdown";
import { globSync } from "glob";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { copyPackageDocs } from "../../../scripts/copy-package-docs";
import { formatDeclarationFiles } from "../../../scripts/format-declarations";

const entries = [
  "src/*.ts",
  "src/*.tsx",
  "src/skills/index.ts",
  "src/skills/compile.ts",
  "src/lifecycle/index.ts",
  "src/chat/index.ts",
  "src/chat/transport.ts",
  "src/chat/react.tsx",
  "src/chat-sdk/index.ts",
  "src/mcp/index.ts",
  "src/mcp/client/index.ts",
  "src/mcp/server/index.ts",
  "src/mcp/client/do-oauth-client-provider.ts",
  "src/mcp/client/x402.ts",
  "src/observability/index.ts",
  "src/observability/ai/index.ts",
  "src/schedules/index.ts",
  "src/schedules/parser.ts",
  "src/tasks/index.ts",
  "src/streams/index.ts",
  "src/websockets/index.ts",
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

const piSourceAliases = {
  "partial-json": resolve("src/harness/partial-json.ts"),
  "@earendil-works/chord/context": resolve(
    "node_modules/chord-dev/dist/context/index.js"
  ),
  "@earendil-works/chord": resolve("node_modules/chord-dev/dist/index.js"),
  "@earendil-works/pi-agent-core": resolve(
    "node_modules/pi-agent-core-dev/dist/index.js"
  ),
  "@earendil-works/pi-ai/utils/uuid": resolve(
    "node_modules/pi-ai-dev/dist/utils/uuid.js"
  ),
  "@earendil-works/pi-ai": resolve("node_modules/pi-ai-dev/dist/index.js"),
  "@earendil-works/pi-telemetry": resolve(
    "node_modules/pi-telemetry-dev/dist/index.js"
  )
};

const bundledPiSources = [
  /^(?:chord-dev|pi-agent-core-dev|pi-ai-dev|pi-sqlite-dev|pi-telemetry-dev)(?:\/|$)/,
  /^@earendil-works\/(?:chord|pi-agent-core|pi-ai|pi-telemetry)(?:\/|$)/
];

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

  // The upstream durable harness is implemented on pi-mono/dev but has not
  // shipped to npm yet. Bundle the exact pinned source revision into the pi
  // entries so consumers do not need an unpublished or source-only dependency.
  await build({
    clean: false,
    dts: true,
    target: "es2021",
    platform: "neutral",
    entry: {
      "harness/index": "src/harness/index.ts",
      "harness/testing": "src/harness/testing.ts",
      "providers/pi/index": "src/providers/pi/index.ts"
    },
    alias: piSourceAliases,
    deps: {
      alwaysBundle: bundledPiSources,
      neverBundle: ["agents/lifecycle"],
      onlyBundle: false,
      dts: { neverBundle: [...bundledPiSources, "agents/lifecycle"] }
    },
    format: "esm",
    sourcemap: true,
    fixedExtension: false
  });

  // then run oxfmt on the generated .d.ts files
  formatDeclarationFiles();

  injectSkillsTypeReference();

  copyPackageDocs(import.meta.url, "agents");

  process.exit(0);
}

main().catch((err) => {
  // Build failures should fail
  console.error(err);
  process.exit(1);
});
