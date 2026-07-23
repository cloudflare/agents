/**
 * Vitest global setup/teardown: boot wrangler once for the whole E2E run.
 */
import { startWrangler, stopWrangler } from "./harness";

export async function setup() {
  await startWrangler();
}

export async function teardown() {
  await stopWrangler();
}
