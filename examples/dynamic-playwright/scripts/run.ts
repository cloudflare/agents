/**
 * Simple test runner, one step above curl by considering `expect-error` markers.
 * Can probably be replaced by a proper test runner like vitest.
 */
import { readFile } from "node:fs/promises";

const [caseFile, endpoint] = process.argv.slice(2);

if (!caseFile || !endpoint) {
  console.error("usage: tsx scripts/run.ts <case-file> <endpoint>");
  process.exit(2);
}

const code = (await readFile(caseFile, "utf8")).replace(/;\s*$/, "");
const expectedError = code.match(/^\/\/ @expect-error (.+)$/m)?.[1];
const response = await fetch(endpoint, {
  method: "POST",
  headers: { "Content-Type": "application/javascript; charset=utf-8" },
  body: code
});

const text = await response.text();
let payload: unknown;
try {
  payload = JSON.parse(text);
} catch {
  console.log(text);
  process.exit(response.ok ? 0 : 1);
}

console.log(
  JSON.stringify(
    payload,
    (_key, value) =>
      typeof value === "string" && value.length > 200
        ? `${value.slice(0, 200)}... (${value.length} chars)`
        : value,
    2
  )
);

const actualError =
  payload &&
  typeof payload === "object" &&
  "error" in payload &&
  typeof payload.error === "string"
    ? payload.error
    : undefined;

if (expectedError) {
  if (!actualError || !actualError.includes(expectedError)) {
    console.error(`expected error containing: ${expectedError}`);
    process.exit(1);
  }
  process.exit(0);
}

if (!response.ok) {
  process.exit(1);
}

if (actualError) {
  process.exit(1);
}
