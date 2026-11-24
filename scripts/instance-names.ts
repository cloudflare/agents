/**
 * The source check for capability instances (INSTANCES.md): a capability
 * must take its table, index and KV names from `this.store`, never write
 * them as literals, or a named instance would share them with the default.
 *
 * In every non-test source file that defines a `LifecycleCapability`, it
 * counts string literals naming storage (`cf_agents_…`, `cf_agents:…`) and
 * `CREATE TABLE` statements. Files written before instances existed are in
 * the baseline with their count; a file over its count, or a new file with
 * any, fails. Moving a capability onto `this.store` lowers its count: run
 * with `--update` to write the lower numbers.
 */
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const BASELINE = "scripts/instance-names-baseline.json";
const LITERAL =
  /(["'`])(?:(?!\1)[^\\\n]|\\.)*?(?:cf_agents_|cf_agents:|CREATE TABLE)(?:(?!\1)[^\\\n]|\\.)*?\1/g;

const files = execSync(
  "git ls-files 'packages/*/src/**/*.ts' | grep -v '/tests\\?/' | grep -v '\\.test\\.ts$'",
  { encoding: "utf8" }
)
  .split("\n")
  .filter(Boolean)
  .filter((file) =>
    /extends LifecycleCapability\b/.test(readFileSync(file, "utf8"))
  );

const counts: Record<string, number> = {};
for (const file of files) {
  const source = readFileSync(file, "utf8");
  const found = source.match(LITERAL)?.length ?? 0;
  if (found > 0) counts[file] = found;
}

if (process.argv.includes("--update")) {
  writeFileSync(BASELINE, `${JSON.stringify(counts, null, 2)}\n`);
  console.log(`Wrote ${BASELINE} (${Object.keys(counts).length} files).`);
  process.exit(0);
}

const baseline = JSON.parse(readFileSync(BASELINE, "utf8")) as Record<
  string,
  number
>;
const over = Object.entries(counts).filter(
  ([file, count]) => count > (baseline[file] ?? 0)
);
if (over.length > 0) {
  for (const [file, count] of over) {
    console.error(
      `${file}: ${count} storage-name literals (allowed ${baseline[file] ?? 0}). ` +
        "Take table, index and key names from this.store."
    );
  }
  process.exit(1);
}
console.log(
  `Instance names: ${files.length} capability files, none over the baseline.`
);
