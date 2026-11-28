// Global setups for the two harness suites: each deploys its own harness's
// Worker (`wrangler.<kind>.jsonc`) under a unique name and deletes it
// afterwards.

import path from "node:path";
import type { TestProject } from "vitest/node";
import { deploy, remove, workerName } from "../shared/deploy";

declare module "vitest" {
  export interface ProvidedContext {
    probeName: string;
  }
}

const DIR = import.meta.dirname;

export type Kind = "pi" | "opencode";

export function deployHarness(
  kind: Kind,
  name: string,
  key: string,
  build: string
) {
  return deploy({
    config: path.join(DIR, `wrangler.${kind}.jsonc`),
    cwd: DIR,
    name,
    key,
    build
  });
}

export async function setup(project: TestProject, kind: Kind) {
  const name = workerName(kind);
  const key = crypto.randomUUID();
  try {
    project.provide("probeUrl", await deployHarness(kind, name, key, "first"));
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
