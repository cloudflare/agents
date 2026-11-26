import { execFileSync, execSync } from "node:child_process";
import * as fs from "node:fs";
import fg from "fast-glob";

execSync("pnpm exec tsx ./.github/resolve-workspace-versions.ts", {
  stdio: "inherit"
});

const tag = await maintenancePublishTag(process.env.GITHUB_REF_NAME ?? "");
if (tag !== undefined) {
  console.log(`Publishing under the "${tag}" dist-tag, not "latest".`);
}
execSync(`pnpm exec changeset publish${tag ? ` --tag ${tag}` : ""}`, {
  stdio: "inherit"
});

/**
 * The dist-tag a maintenance release publishes under, or undefined for
 * `latest`.
 *
 * Changesets tags every publish `latest`. From main that is right; from a
 * `release/<line>` branch it would move `latest` back to the older line once
 * a newer release exists, and `npm install agents` would install it. So a
 * maintenance release keeps `latest` only if every package it publishes is
 * newer than that package's `latest`; otherwise it publishes under
 * `release-<line>` (`npm install agents@release-0.34`).
 */
async function maintenancePublishTag(
  refName: string
): Promise<string | undefined> {
  if (!refName.startsWith("release/")) return undefined;
  const fallback = `release-${refName.slice("release/".length).replaceAll("/", "-")}`;
  for (const file of await fg.glob("./packages/*/package.json")) {
    const {
      name,
      version,
      private: isPrivate
    } = JSON.parse(fs.readFileSync(file, "utf8")) as {
      name: string;
      version: string;
      private?: boolean;
    };
    if (isPrivate) continue;
    const published = npmView(`${name}@${version}`, "version");
    // Already on npm, so Changesets skips it.
    if (published === version) continue;
    const latest = npmView(name, "dist-tags.latest");
    if (latest !== undefined && !isNewer(version, latest)) {
      console.log(`${name}@${version} is not newer than latest ${latest}.`);
      return fallback;
    }
  }
  return undefined;
}

/**
 * `npm view <spec> <field>`, or undefined when npm has no such package or
 * version. Any other failure throws: guessing could move `latest`.
 */
function npmView(spec: string, field: string): string | undefined {
  try {
    const out = execFileSync("npm", ["view", spec, field], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    }).trim();
    return out === "" ? undefined : out;
  } catch (error) {
    const stderr = (error as { stderr?: unknown }).stderr;
    if (typeof stderr === "string" && stderr.includes("E404")) return undefined;
    throw error;
  }
}

/** Whether release version `a` (x.y.z) is newer than `b`. */
function isNewer(a: string, b: string): boolean {
  const parse = (v: string) => v.split(/[-+]/)[0]?.split(".").map(Number) ?? [];
  const [pa, pb] = [parse(a), parse(b)];
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d > 0;
  }
  return false;
}
