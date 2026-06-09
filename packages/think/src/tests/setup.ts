import { afterAll, beforeAll } from "vitest";
import { exports } from "cloudflare:workers";

const WARMUP_TIMEOUT_MS = 60_000;

// Warm up the worker module graph before tests run.
beforeAll(async () => {
  await exports.default.fetch("http://warmup/");
}, WARMUP_TIMEOUT_MS);

// Give DOs a moment to finish WebSocket close handlers before
// the module is invalidated between test files.
afterAll(() => new Promise((resolve) => setTimeout(resolve, 100)));
