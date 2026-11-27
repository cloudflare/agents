// Global setup: deploy the soak Worker under a unique name and delete it
// afterwards.

import path from "node:path";
import type { TestProject } from "vitest/node";
import { deploy, remove } from "../shared/deploy";

const DIR = import.meta.dirname;

export default async function setup(project: TestProject) {
  const name = `nightly-soak-${Date.now().toString(36)}`;
  const key = crypto.randomUUID();
  try {
    const url = await deploy({
      config: path.join(DIR, "wrangler.jsonc"),
      cwd: DIR,
      name,
      key,
      build: "soak"
    });
    project.provide("probeUrl", url);
    project.provide("probeKey", key);
  } catch (e) {
    try {
      remove(name, DIR);
    } catch {
      // never deployed
    }
    throw e;
  }
  return () => remove(name, DIR);
}
