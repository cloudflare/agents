import { afterAll, beforeAll } from "vitest";
import { exports } from "cloudflare:workers";

// Warm up the worker module graph before tests run.
beforeAll(async () => {
  await exports.default.fetch("http://warmup/");
}, 30_000);

// Give DOs a moment to finish WebSocket close handlers before
// the module is invalidated between test files.
afterAll(() => new Promise((resolve) => setTimeout(resolve, 100)));
