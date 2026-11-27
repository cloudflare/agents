// Global setups for the two harness suites: each deploys the harness Worker
// under its own unique name (so one suite's code update does not reset the
// other's objects) and deletes it afterwards.

import path from "node:path";
import type { TestProject } from "vitest/node";
import { deploy, remove } from "../shared/deploy";

declare module "vitest" {
  export interface ProvidedContext {
    probeName: string;
  }
}

const DIR = import.meta.dirname;

export function deployHarnesses(name: string, key: string, build: string) {
  return deploy({
    config: path.join(DIR, "wrangler.jsonc"),
    cwd: DIR,
    name,
    key,
    build
  });
}

export async function setup(project: TestProject, prefix: string) {
  const name = `${prefix}-${Date.now().toString(36)}`;
  const key = crypto.randomUUID();
  try {
    project.provide("probeUrl", await deployHarnesses(name, key, "first"));
    project.provide("probeKey", key);
    project.provide("probeName", name);
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
