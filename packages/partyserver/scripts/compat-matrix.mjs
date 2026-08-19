#!/usr/bin/env node
// Layer B compat-matrix runner. Runs the date-agnostic `compat-*.test.ts` suite
// under vitest-pool-workers at several compatibility dates, overriding the
// runtime date per run via the COMPAT_DATE env var.
//
// Dates are capped at the workerd version bundled by this repo's
// vitest-pool-workers (currently ~2026-04-26). The 2026-06-11 ceiling and the
// real-network behaviors are covered by the Layer A `.compat-harness/` (real
// wrangler dev) and by the agents/voice suites in the agents repo.

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const PKG_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG = "src/tests/vitest.compat.config.ts";

const DATES = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ["2026-01-28", "2026-03-24", "2026-04-07", "2026-04-21"];

let failed = false;
for (const date of DATES) {
  console.log(`\n=== compat-matrix: COMPAT_DATE=${date} ===`);
  const res = spawnSync("npx", ["vitest", "run", "--config", CONFIG], {
    cwd: PKG_DIR,
    stdio: "inherit",
    env: { ...process.env, COMPAT_DATE: date }
  });
  if (res.status !== 0) {
    failed = true;
    console.error(`compat-matrix FAILED at ${date}`);
  }
}

console.log(failed ? "\ncompat-matrix: FAIL" : "\ncompat-matrix: PASS");
process.exit(failed ? 1 : 0);
