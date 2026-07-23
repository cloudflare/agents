// Rewrites the AI SDK dependency ranges of the packages that support both AI
// SDK v6 and v7 to a single target major, so CI can install-and-test each major
// against the shared `ai@^6 || ^7` / `@ai-sdk/react@^3 || ^4` peer ranges.
//
// This only touches `dependencies` / `devDependencies` (never
// `peerDependencies`), and is meant to run in throwaway CI checkouts — it is not
// a committed change to the manifests.
//
// Usage: node scripts/use-ai-sdk-major.mjs <6|7>

import { readFileSync, writeFileSync } from "node:fs";

const major = process.argv[2];
if (major !== "6" && major !== "7") {
  console.error("usage: node scripts/use-ai-sdk-major.mjs <6|7>");
  process.exit(1);
}

// AI SDK v7 pairs with @ai-sdk/* and workers-ai-provider v4; v6 pairs with
// @ai-sdk/* and workers-ai-provider v3.
const ranges =
  major === "6"
    ? {
        ai: "^6.0.0",
        "@ai-sdk/react": "^3.0.0",
        "@ai-sdk/openai": "^3.0.0",
        "@ai-sdk/anthropic": "^3.0.0",
        "@ai-sdk/google": "^3.0.0",
        "workers-ai-provider": "^3.3.0"
      }
    : {
        ai: "^7.0.0",
        "@ai-sdk/react": "^4.0.0",
        "@ai-sdk/openai": "^4.0.0",
        "@ai-sdk/anthropic": "^4.0.0",
        "@ai-sdk/google": "^4.0.0",
        "workers-ai-provider": "^4.0.0"
      };

const manifests = [
  "packages/think/package.json",
  "packages/agents/package.json",
  "packages/ai-chat/package.json",
  "packages/codemode/package.json"
];

for (const path of manifests) {
  const pkg = JSON.parse(readFileSync(path, "utf8"));
  let changed = false;
  for (const field of ["dependencies", "devDependencies"]) {
    const deps = pkg[field];
    if (!deps) continue;
    for (const [name, range] of Object.entries(ranges)) {
      if (name in deps && deps[name] !== range) {
        deps[name] = range;
        changed = true;
      }
    }
  }
  if (changed) {
    writeFileSync(path, `${JSON.stringify(pkg, null, 2)}\n`);
    console.log(`${path} -> AI SDK v${major}`);
  }
}
