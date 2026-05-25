#!/usr/bin/env node
/**
 * Coverage script for the codebase navigation index.
 *
 * Reads all .md files in this directory, extracts links that point to
 * TypeScript source files (with optional #L<start>-L<end> line ranges),
 * and reports what percentage of the source code is referenced.
 *
 * Usage:
 *   node .navigation/coverage.js
 *   node .navigation/coverage.js --uncovered   # also list uncovered files
 *   node .navigation/coverage.js --verbose     # show per-file detail
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

const VERBOSE = process.argv.includes("--verbose");
const SHOW_UNCOVERED = process.argv.includes("--uncovered");

const MAX_RANGE = 300;

// ---------------------------------------------------------------------------
// 1. Collect source files we care about
// ---------------------------------------------------------------------------

const EXCLUDE_DIRS = new Set([
  "node_modules",
  "dist",
  ".git",
  "tests",
  "e2e-tests",
  "react-tests",
  "browser-tests",
  "webmcp-tests",
  "x402-tests",
  "cli-tests",
  "tests-d"
]);

const EXCLUDE_FILE_PATTERNS = [
  /\.d\.ts$/,
  /\.config\.(ts|tsx|js)$/,
  /\.test\.(ts|tsx)$/,
  /\.spec\.(ts|tsx)$/,
  /vitest\./,
  /playwright\./
];

const SOURCE_ROOTS = [
  path.join(REPO_ROOT, "packages"),
  path.join(REPO_ROOT, "voice-providers")
];

function isExcluded(filePath) {
  return EXCLUDE_FILE_PATTERNS.some((re) => re.test(filePath));
}

function collectSourceFiles(dir) {
  const results = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of entries) {
    if (EXCLUDE_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectSourceFiles(full));
    } else if (/\.(ts|tsx)$/.test(entry.name) && !isExcluded(full)) {
      results.push(full);
    }
  }
  return results;
}

const allSourceFiles = SOURCE_ROOTS.flatMap(collectSourceFiles);

// Map from absolute path -> total line count
const fileTotals = new Map();
for (const f of allSourceFiles) {
  const lines = fs.readFileSync(f, "utf8").split("\n").length;
  fileTotals.set(f, lines);
}

// ---------------------------------------------------------------------------
// 2. Parse markdown files and extract code references
// ---------------------------------------------------------------------------

// Matches: [any text](relative/path.ts) or [any text](relative/path.ts#L10-L50)
// or just #L10 (single line)
const LINK_RE = /\[([^\]]*)\]\(([^)]+\.tsx?(?:#L\d+(?:-L\d+)?)?)\)/g;
const RANGE_RE = /#L(\d+)(?:-L(\d+))?$/;

function parseMarkdownLinks(mdPath) {
  const content = fs.readFileSync(mdPath, "utf8");
  const refs = [];
  let m;
  LINK_RE.lastIndex = 0;
  while ((m = LINK_RE.exec(content)) !== null) {
    const rawHref = m[2]; // eslint-disable-line no-unused-vars (used in refs below)
    // Resolve the file path (strip fragment)
    const rangeMatch = rawHref.match(RANGE_RE);
    const relFile = rawHref.replace(RANGE_RE, "");
    const absFile = path.resolve(path.dirname(mdPath), relFile);

    // Only track if it points to a real source file we know about
    if (!fileTotals.has(absFile)) continue;

    if (rangeMatch) {
      const start = parseInt(rangeMatch[1], 10);
      const end = rangeMatch[2] ? parseInt(rangeMatch[2], 10) : start;
      refs.push({ file: absFile, start, end, text: m[1], rawHref });
    } else {
      // Whole-file reference — mark every line covered
      refs.push({ file: absFile, start: 1, end: fileTotals.get(absFile), text: m[1], rawHref });
    }
  }
  return refs;
}

const navDir = __dirname;
const mdFiles = fs
  .readdirSync(navDir)
  .filter((f) => f.endsWith(".md"))
  .map((f) => path.join(navDir, f));

// Map from absolute source path -> Set of covered line numbers
const coveredLines = new Map();

// Oversized ranges: { mdFile, text, file, start, end, size }
const oversizedRanges = [];

for (const md of mdFiles) {
  const refs = parseMarkdownLinks(md);
  for (const { file, start, end, text, rawHref } of refs) {
    const size = end - start + 1;
    if (size > MAX_RANGE) {
      oversizedRanges.push({
        mdFile: path.basename(md),
        text,
        rel: path.relative(REPO_ROOT, file),
        start,
        end,
        size
      });
      continue; // don't count toward coverage
    }
    if (!coveredLines.has(file)) coveredLines.set(file, new Set());
    const s = coveredLines.get(file);
    for (let i = start; i <= end; i++) s.add(i);
  }
}

// ---------------------------------------------------------------------------
// 3. Compute and print stats
// ---------------------------------------------------------------------------

let totalLines = 0;
let totalCovered = 0;

// Per-file stats
const fileStats = [];
for (const [file, total] of fileTotals) {
  const covered = coveredLines.has(file) ? coveredLines.get(file).size : 0;
  totalLines += total;
  totalCovered += covered;
  fileStats.push({ file, total, covered });
}

fileStats.sort((a, b) => b.total - a.total);

const pct = (c, t) => (t === 0 ? "0.0" : ((c / t) * 100).toFixed(1));

console.log("\n=== Codebase Navigation Coverage ===\n");
console.log(
  `Overall: ${totalCovered.toLocaleString()} / ${totalLines.toLocaleString()} lines covered  (${pct(totalCovered, totalLines)}%)`
);
console.log(`Source files tracked: ${allSourceFiles.length}`);
console.log(
  `Source files referenced: ${[...coveredLines.keys()].length}`
);
console.log(`Navigation docs scanned: ${mdFiles.length}`);

if (oversizedRanges.length > 0) {
  oversizedRanges.sort((a, b) => b.size - a.size);
  console.log(
    `\n--- Oversized ranges (>${MAX_RANGE} lines, NOT counted, ${oversizedRanges.length} total) ---\n`
  );
  for (const { mdFile, text, rel, start, end, size } of oversizedRanges) {
    const label = text.length > 50 ? text.slice(0, 47) + "…" : text;
    console.log(
      `  ${size.toString().padStart(5)} lines  ${rel}#L${start}-L${end}  [${label}]  (${mdFile})`
    );
  }
}

if (VERBOSE) {
  console.log("\n--- Per-file coverage (source files, largest first) ---\n");
  for (const { file, total, covered } of fileStats) {
    const rel = path.relative(REPO_ROOT, file);
    const bar = covered === 0 ? "░░░░░░░░░░" : "▓".repeat(Math.round((covered / total) * 10)).padEnd(10, "░");
    console.log(
      `  ${bar} ${pct(covered, total).padStart(5)}%  ${rel}  (${covered}/${total})`
    );
  }
}

if (SHOW_UNCOVERED) {
  const uncovered = fileStats.filter((s) => s.covered === 0);
  if (uncovered.length === 0) {
    console.log("\nAll source files have at least one line referenced.");
  } else {
    console.log(
      `\n--- Uncovered source files (${uncovered.length} files, ${uncovered.reduce((a, s) => a + s.total, 0).toLocaleString()} lines) ---\n`
    );
    for (const { file, total } of uncovered) {
      const rel = path.relative(REPO_ROOT, file);
      console.log(`  ${total.toString().padStart(5)} lines  ${rel}`);
    }
  }
}

// Partially covered files (covered but <50%)
const partial = fileStats.filter(
  (s) => s.covered > 0 && s.covered / s.total < 0.5
);
if (partial.length > 0 && (VERBOSE || SHOW_UNCOVERED)) {
  console.log(
    `\n--- Partially covered files (<50%, ${partial.length} files) ---\n`
  );
  for (const { file, total, covered } of partial) {
    const rel = path.relative(REPO_ROOT, file);
    console.log(
      `  ${pct(covered, total).padStart(5)}%  (${covered}/${total})  ${rel}`
    );
  }
}

console.log();
