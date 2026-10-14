import { build } from "tsdown";
import { globSync } from "glob";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { copyPackageDocs } from "../../../scripts/copy-package-docs";
import { formatDeclarationFiles } from "../../../scripts/format-declarations";
import { buildDaemon } from "./build-daemon";

const entries = [
  "src/*.ts",
  "src/*.tsx",
  "src/skills/index.ts",
  "src/skills/compile.ts",
  "src/lifecycle/index.ts",
  "src/harness/opencode/index.ts",
  "src/harness/pi/index.ts",
  "src/harness/think/index.ts",
  "src/harness/container/index.ts",
  "src/harness/container/daemon/index.ts",
  "src/harness/container/runtime/index.ts",
  "src/harness/store/index.ts",
  "src/routing/index.ts",
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
  "src/models/ai-sdk/index.ts",
  "src/models/opencode/index.ts",
  "src/models/pi-ai/index.ts",
  "src/observability/ai/index.ts",
  "src/queue/index.ts",
  "src/schedules/index.ts",
  "src/schedules/parser.ts",
  "src/tasks/index.ts",
  "src/streams/index.ts",
  "src/context/index.ts",
  "src/sessions/index.ts",
  "src/state/index.ts",
  "src/websockets/index.ts",
  "src/codemode/ai.ts",
  "src/browser/index.ts",
  "src/browser/ai.ts",
  "src/browser/tools/ai-sdk.ts",
  "src/browser/tools/tanstack-ai.ts",
  "src/browser/tools/pi.ts",
  "src/web/search/index.ts",
  "src/web/search/tools/pi.ts",
  "src/web/search/tools/ai-sdk.ts",
  "src/web/search/tools/tanstack-ai.ts",
  "src/web/fetch/index.ts",
  "src/web/fetch/tools/pi.ts",
  "src/web/fetch/tools/ai-sdk.ts",
  "src/web/fetch/tools/tanstack-ai.ts",
  "src/experimental/webmcp.ts",
  "src/voice/index.ts",
  "src/voice/types.ts",
  "src/voice/client.ts",
  "src/voice/react.tsx",
  "src/voice/errors.ts",
  "src/voice/workers-ai.ts",
  "src/voice/sfu.ts",
  "src/voice/text.ts",
  "src/experimental/channels/index.ts",
  "src/experimental/channels/email/index.ts",
  "src/experimental/channels/slack/index.ts",
  "src/experimental/channels/telegram/index.ts",
  "src/experimental/channels/web/index.ts",
  "src/experimental/channels/web/client.ts",
  "src/experimental/channels/web/ai-sdk.ts",
  "src/experimental/channels/projections/ai-sdk.ts",
  "src/experimental/channels/projections/pi.ts"
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
  // Embedded in agents/harness/container, so it must exist first.
  await buildDaemon();

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

  // The CLI is self-contained: its dependencies are devDependencies bundled
  // here, so installing `agents` pulls in none of them.
  await build({
    clean: false,
    dts: false,
    platform: "node",
    target: "node22",
    entry: { cli: "src/cli/index.ts" },
    deps: {
      onlyBundle: [
        "@earendil-works/pi-tui",
        "highlight.js",
        "marked",
        "get-east-asian-width"
      ]
    },
    format: "esm",
    minify: true,
    banner: "#!/usr/bin/env node",
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
