// Global setup: deploy the fault Worker under a unique name and delete it
// afterwards. With FAULTS_URL set, the suite runs against that deployment
// and deploys nothing.

import { execFileSync } from "node:child_process";
import path from "node:path";
import type { TestProject } from "vitest/node";

declare module "vitest" {
  export interface ProvidedContext {
    faultsUrl: string;
  }
}

const CONFIG = path.join(import.meta.dirname, "wrangler.jsonc");

function wrangler(args: string[]): string {
  try {
    return execFileSync("npx", ["wrangler", ...args], {
      cwd: import.meta.dirname,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, NO_COLOR: "1" }
    });
  } catch (e) {
    // Keep the error short: wrangler's output repeats every bundling warning.
    const { stderr } = e as { stderr?: string };
    const tail = (stderr ?? String(e)).slice(-1500);
    throw new Error(`wrangler ${args[0]} failed:\n${tail}`);
  }
}

/**
 * A new workers.dev name answers from the Worker on some requests before
 * others: wait for ten answers in a row from the Worker itself.
 */
async function waitLive(url: string) {
  let inARow = 0;
  for (let i = 0; i < 120 && inARow < 10; i++) {
    try {
      const res = await fetch(url);
      // The Worker answers unknown paths with its own 404.
      inARow = (await res.text()) === "Not found" ? inARow + 1 : 0;
    } catch {
      inARow = 0;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  if (inARow < 10) throw new Error(`${url} did not come up`);
}

export default async function setup(project: TestProject) {
  const given = process.env.FAULTS_URL;
  if (given) {
    project.provide("faultsUrl", given);
    return;
  }
  const name = `nightly-faults-${Date.now().toString(36)}`;
  const out = wrangler(["deploy", "--config", CONFIG, "--name", name]);
  const url = out.match(/https:\/\/[^\s]+\.workers\.dev/)?.[0];
  if (!url) throw new Error(`no workers.dev URL in the deploy output:\n${out}`);
  await waitLive(url);
  project.provide("faultsUrl", url);
  return () => {
    wrangler(["delete", "--name", name, "--force"]);
  };
}
