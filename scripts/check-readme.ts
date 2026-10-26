/**
 * The root README is also the `agents` npm README. npm publishes
 * packages/agents/README.md, so that file is an exact copy of the root one.
 *
 *   pnpm run check:readme           fails if the copy differs, the README
 *                                   has a relative link (it breaks on npm),
 *                                   a synced code block differs from its
 *                                   file, or an install pins Pi to a range
 *                                   `agents` does not support
 *   pnpm run check:readme --write   updates the copy
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const source = resolve(root, "README.md");
const copy = resolve(root, "packages/agents/README.md");

const readme = readFileSync(source, "utf8");
const problems: string[] = [];

// Inline links `[text](url)`, reference definitions `[id]: url`, and HTML
// `href="url"` or `src="url"`. Markdown allows `<url>` in the first two.
const linkPatterns = [
  /\]\(<?([^)\s>]+)>?\)/g,
  /^\s*\[[^\]]+\]:\s*<?([^\s>]+)>?/gm,
  /\b(?:href|src)="([^"]+)"/g
];

const relativeLinks = linkPatterns
  .flatMap((pattern) => [...readme.matchAll(pattern)])
  .map((match) => match[1])
  .filter((target) => !/^(https?:|mailto:|#)/.test(target));

for (const link of relativeLinks) {
  problems.push(`relative link, which breaks on npmjs.com: ${link}`);
}

// A code block after `<!-- readme-sync: path -->` must match that file, so
// the quick start is an example that CI typechecks.
const syncedBlocks = readme.matchAll(
  /<!-- readme-sync: (\S+) -->\s*```[^\n]*\n([\s\S]*?)```/g
);
for (const [, path, code] of syncedBlocks) {
  let file: string;
  try {
    file = readFileSync(resolve(root, path), "utf8");
  } catch {
    problems.push(`readme-sync names a missing file: ${path}`);
    continue;
  }
  if (file !== code) {
    problems.push(`the code block synced with ${path} differs from the file`);
  }
}

// Pi can change its API in a minor release, and `agents` supports one Pi
// minor at a time. An install without the range gets whatever Pi published
// last, which can fail on the peer dependency.
const { peerDependencies } = JSON.parse(
  readFileSync(resolve(root, "packages/agents/package.json"), "utf8")
) as { peerDependencies: Record<string, string> };
const installs = readme
  .split("\n")
  .filter((line) => line.startsWith("npm install"));
for (const line of installs) {
  for (const [, name, range] of line.matchAll(
    /(@earendil-works\/[\w-]+)(?:@(\S+))?/g
  )) {
    if (range !== peerDependencies[name]) {
      problems.push(
        `npm install pins ${name} to ${range ?? "nothing"}, but agents supports ${peerDependencies[name] ?? "no version of it"}`
      );
    }
  }
}

if (problems.length > 0) {
  console.error("README.md:");
  for (const problem of problems) console.error(`  ${problem}`);
  process.exit(1);
}

if (process.argv.includes("--write")) {
  writeFileSync(copy, readme);
} else if (readFileSync(copy, "utf8") !== readme) {
  console.error(
    "packages/agents/README.md differs from README.md. Run `pnpm run check:readme --write`."
  );
  process.exit(1);
}
