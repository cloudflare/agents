// Global setup: deploy the fault Worker under a unique name and delete it
// afterwards. With PROBE_URL and PROBE_KEY set, the suite runs against that
// deployment and deploys nothing.

import path from "node:path";
import type { TestProject } from "vitest/node";
import { deploy, remove, workerName } from "../shared/deploy";

const DIR = import.meta.dirname;

export default async function setup(project: TestProject) {
  const given = process.env.PROBE_URL;
  if (given) {
    project.provide("probeUrl", given);
    project.provide("probeKey", process.env.PROBE_KEY ?? "");
    return;
  }
  // The fault suite and the fuzz share this Worker; each job deploys its own.
  const name = workerName(project.config.name.replace(/^nightly-/, ""));
  const key = crypto.randomUUID();
  try {
    const url = await deploy({
      config: path.join(DIR, "wrangler.jsonc"),
      cwd: DIR,
      name,
      key,
      build: "faults"
    });
    project.provide("probeUrl", url);
    project.provide("probeKey", key);
  } catch (e) {
    // Vitest only runs the teardown when setup returns it: delete here.
    try {
      remove(name, DIR);
    } catch {
      // never deployed
    }
    throw e;
  }
  return () => remove(name, DIR);
}
