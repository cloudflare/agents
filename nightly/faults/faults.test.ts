// The fault suite: every scenario against both agents on one deployment,
// each checked by the invariants. A scenario's full outcome is written to
// `results/` for whoever reads a failure.

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, inject, it } from "vitest";
import { violations } from "./invariants";
import type { Cls } from "../shared/probe";
import { CHAT_ONLY, SCENARIOS, THINK_ONLY } from "./scenarios";

const RESULTS = path.join(import.meta.dirname, "results");

beforeAll(() => {
  process.env.PROBE_URL = inject("probeUrl");
  process.env.PROBE_KEY = inject("probeKey");
  mkdirSync(RESULTS, { recursive: true });
});

const only = process.env.FAULTS_ONLY?.split(",");
const unknown = only?.filter((name) => !(name in SCENARIOS)) ?? [];
if (unknown.length)
  throw new Error(`FAULTS_ONLY names no scenario: ${unknown.join(", ")}`);

for (const cls of ["chat", "think"] as Cls[]) {
  describe.concurrent(cls, () => {
    for (const [name, run] of Object.entries(SCENARIOS)) {
      if (only && !only.includes(name)) continue;
      if (cls === "chat" && THINK_ONLY.has(name)) continue;
      if (cls === "think" && CHAT_ONLY.has(name)) continue;
      it(name, async () => {
        const result = await run(cls);
        writeFileSync(
          path.join(RESULTS, `${cls}-${name}.json`),
          JSON.stringify(result, null, 1)
        );
        expect(violations(result)).toEqual([]);
      });
    }
  });
}
