#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const COMMIT = "1e1392e3f91583884fe82a0b4b91335875c3fba6";
const EXPECTED_SHA256 =
  "3a94417774fa20b17971e8162f9865b1cefd2650c7d88fdcd17f971d91213852";
const SOURCE_URL = `https://raw.githubusercontent.com/modelcontextprotocol/typescript-sdk/${COMMIT}/test/conformance/src/everythingServer.ts`;

const response = await fetch(SOURCE_URL);
if (!response.ok) {
  throw new Error(`Failed to fetch ${SOURCE_URL}: ${response.status}`);
}
const source = await response.text();
const actual = createHash("sha256").update(source).digest("hex");
if (actual !== EXPECTED_SHA256) {
  throw new Error(
    `Upstream source hash mismatch: expected ${EXPECTED_SHA256}, received ${actual}`
  );
}

const directory = await mkdtemp(join(tmpdir(), "mcp-v2-conformance-"));
const upstream = join(directory, "everythingServer.ts");
await writeFile(upstream, source);
console.log(`Verified upstream source at ${COMMIT}.`);
console.log("The following diff is the intentional workerd adaptation:\n");
const diff = spawnSync(
  "git",
  [
    "diff",
    "--no-index",
    "--",
    upstream,
    new URL("./everything-server-v2.ts", import.meta.url).pathname
  ],
  { stdio: "inherit" }
);
// git diff returns 1 when files differ, which is expected for an adaptation.
if (diff.status !== 0 && diff.status !== 1) process.exit(diff.status ?? 2);
