// Deploying and deleting the suites' probe Workers with wrangler.

import { execFileSync } from "node:child_process";
import path from "node:path";

/** This workspace's wrangler, also for a build outside it (the release). */
const WRANGLER = path.join(
  import.meta.dirname,
  "..",
  "node_modules",
  ".bin",
  "wrangler"
);

declare module "vitest" {
  export interface ProvidedContext {
    probeUrl: string;
    probeKey: string;
  }
}

export function wrangler(args: string[], cwd: string): string {
  try {
    return execFileSync(WRANGLER, args, {
      cwd,
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
 * Deploy `config` (from `cwd`) as `name`. The Worker answers only requests
 * that carry `key`, and `/ready` answers `ready:<build>`.
 */
export async function deploy(opts: {
  config: string;
  cwd: string;
  name: string;
  key: string;
  build: string;
}): Promise<string> {
  const out = wrangler(
    [
      "deploy",
      "--config",
      opts.config,
      "--name",
      opts.name,
      "--var",
      `PROBE_KEY:${opts.key}`,
      "--var",
      `BUILD:${opts.build}`
    ],
    opts.cwd
  );
  const url = out.match(/https:\/\/[^\s]+\.workers\.dev/)?.[0];
  if (!url) {
    throw new Error(
      `no workers.dev URL in the deploy output:\n${out.slice(-1500)}`
    );
  }
  await waitLive(url, opts.key, opts.build);
  return url;
}

export function remove(name: string, cwd: string) {
  wrangler(["delete", "--name", name, "--force"], cwd);
}

/**
 * A new workers.dev name, or a new version, answers on some requests before
 * others: wait for ten answers in a row from `build`.
 */
async function waitLive(url: string, key: string, build: string) {
  let inARow = 0;
  for (let i = 0; i < 180 && inARow < 10; i++) {
    try {
      const res = await fetch(`${url}/ready?key=${key}`);
      inARow = (await res.text()) === `ready:${build}` ? inARow + 1 : 0;
    } catch {
      inARow = 0;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  if (inARow < 10) throw new Error(`${url} did not serve ${build}`);
}
