import { build } from "tsdown";
import { globSync } from "glob";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { formatDeclarationFiles } from "../../../scripts/format-declarations";

const entries = [
  "src/*.ts",
  "src/*.tsx",
  "src/skills/index.ts",
  "src/skills/compile.ts",
  "src/chat/index.ts",
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

function moduleSpecifiers(source: string): string[] {
  const specifiers = new Set<string>();
  for (const pattern of [
    /\bfrom\s+["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\bimport\s+["']([^"']+)["']/g
  ]) {
    for (const match of source.matchAll(pattern)) {
      const specifier = match[1];
      if (specifier) specifiers.add(specifier);
    }
  }
  return [...specifiers];
}

function resolveEmittedImport(
  importer: string,
  specifier: string,
  declarationGraph: boolean
): string | undefined {
  if (!specifier.startsWith(".")) return undefined;
  const imported = resolve(dirname(importer), specifier);
  const candidates = declarationGraph
    ? [
        imported.replace(/\.(?:m?js)$/, ".d.ts"),
        `${imported}.d.ts`,
        resolve(imported, "index.d.ts")
      ]
    : [imported, `${imported}.js`, resolve(imported, "index.js")];
  return candidates.find((candidate) => existsSync(candidate));
}

function assertRootHasNoAIFrameworkDependency(): void {
  for (const entry of ["dist/index.js", "dist/index.d.ts"]) {
    const declarationGraph = entry.endsWith(".d.ts");
    const pending = [resolve(entry)];
    const visited = new Set<string>();

    while (pending.length > 0) {
      const file = pending.pop();
      if (!file || visited.has(file)) continue;
      visited.add(file);

      for (const specifier of moduleSpecifiers(readFileSync(file, "utf8"))) {
        if (specifier === "ai" || specifier.startsWith("@ai-sdk/")) {
          throw new Error(
            `${entry} reaches AI framework import "${specifier}" through ${file}`
          );
        }
        const imported = resolveEmittedImport(
          file,
          specifier,
          declarationGraph
        );
        if (imported) pending.push(imported);
      }
    }
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
  assertRootHasNoAIFrameworkDependency();

  process.exit(0);
}

main().catch((err) => {
  // Build failures should fail
  console.error(err);
  process.exit(1);
});
