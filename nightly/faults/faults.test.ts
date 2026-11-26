// The fault suite: every scenario against both agents on one deployment,
// each checked by the invariants. A scenario's full outcome is written to
// `results/` for whoever reads a failure.

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, inject, it } from "vitest";
import { violations } from "./invariants";
import { isThink, type Cls } from "../shared/probe";
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

// Each class at the root and as a facet sub-agent of a hub.
const CLASSES: Cls[] = ["chat", "think", "fchat", "fthink"];
const classes = [
  ...new Set(
    (process.env.FAULTS_CLASSES ?? CLASSES.join(","))
      .split(",")
      .map((c) => c.trim())
  )
] as Cls[];
const unknownClasses = classes.filter((c) => !CLASSES.includes(c));
if (unknownClasses.length) {
  throw new Error(
    `FAULTS_CLASSES names no class: ${unknownClasses.join(", ")}`
  );
}

for (const cls of classes) {
  describe.concurrent(cls, () => {
    for (const [name, run] of Object.entries(SCENARIOS)) {
      if (only && !only.includes(name)) continue;
      if (!isThink(cls) && THINK_ONLY.has(name)) continue;
      if (isThink(cls) && CHAT_ONLY.has(name)) continue;
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
