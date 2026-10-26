/**
 * The root README is also the `agents` npm README. npm publishes
 * packages/agents/README.md, so that file is an exact copy of the root one.
 *
 *   pnpm run check:readme           fails if the copy differs, or the README
 *                                   has a relative link (it breaks on npm)
 *   pnpm run check:readme --write   updates the copy
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const source = resolve(root, "README.md");
const copy = resolve(root, "packages/agents/README.md");

const readme = readFileSync(source, "utf8");

// Inline links `[text](url)`, reference definitions `[id]: url`, and HTML
// `href="url"` or `src="url"`.
const linkPatterns = [
  /\]\(([^)\s]+)\)/g,
  /^\s*\[[^\]]+\]:\s*(\S+)/gm,
  /\b(?:href|src)="([^"]+)"/g
];

const relativeLinks = linkPatterns
  .flatMap((pattern) => [...readme.matchAll(pattern)])
  .map((match) => match[1])
  .filter((target) => !/^(https?:|mailto:|#)/.test(target));

if (relativeLinks.length > 0) {
  console.error(
    "README.md has relative links, which break on npmjs.com. Use absolute URLs:"
  );
  for (const link of relativeLinks) console.error(`  ${link}`);
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
