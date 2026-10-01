#!/usr/bin/env node
// Rebuild the vendored pi archives from a pi checkout.
//
//   node vendor/pi-dev/pack.mjs /path/to/earendil-works/pi
//
// The checkout must already be built (`npm ci --ignore-scripts`, then
// `npm run build` in chord, telemetry, ai and durable). This packs each
// package, drops sibling `@earendil-works/*` dependencies (the example
// installs every archive itself, and Vite/tsconfig dedupe them) and the
// dependencies the Worker bundle never imports, and rewrites SHA256SUMS.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const here = import.meta.dirname;
const checkout = resolve(process.argv[2] ?? "");
if (!process.argv[2]) {
  console.error("usage: node pack.mjs <pi checkout>");
  process.exit(1);
}

/** Package directory → third-party dependencies the Worker bundle needs. */
const PACKAGES = {
  chord: [],
  telemetry: [],
  // The example only uses the openai-completions API (Workers AI) and faux.
  ai: ["openai", "partial-json", "typebox"],
  durable: ["diff", "typebox"]
};

const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: checkout })
  .toString()
  .trim();

for (const file of readdirSync(here)) {
  if (file.endsWith(".tgz")) rmSync(join(here, file));
}

const sums = [];
for (const [dir, keep] of Object.entries(PACKAGES)) {
  const work = mkdtempSync(join(tmpdir(), `pi-pack-${dir}-`));
  const source = join(checkout, "packages", dir);
  execFileSync("npm", ["pack", "--pack-destination", work], {
    cwd: source,
    stdio: "ignore"
  });
  const [archive] = readdirSync(work).filter((f) => f.endsWith(".tgz"));
  execFileSync("tar", ["-xzf", archive], { cwd: work });
  const manifestPath = join(work, "package", "package.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const dependencies = {};
  for (const name of keep) {
    const version = manifest.dependencies?.[name];
    if (!version) throw new Error(`${dir} has no dependency ${name}`);
    dependencies[name] = version;
  }
  manifest.dependencies = dependencies;
  delete manifest.devDependencies;
  delete manifest.scripts;
  manifest.gitHead = commit;
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  // npm pack writes fixed mtimes and sorted entries, so the bytes are stable.
  execFileSync(
    "npm",
    ["pack", "--ignore-scripts", "--pack-destination", here],
    { cwd: join(work, "package"), stdio: "ignore" }
  );
  rmSync(work, { recursive: true, force: true });
  const bytes = readFileSync(join(here, archive));
  sums.push(`${createHash("sha256").update(bytes).digest("hex")}  ${archive}`);
  console.log(`packed ${archive}`);
}

writeFileSync(join(here, "SHA256SUMS"), `${sums.join("\n")}\n`);
console.log(`pi ${commit}`);
