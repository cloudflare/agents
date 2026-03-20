import { afterAll, beforeAll } from "vitest";
import { exports } from "cloudflare:workers";

// @ts-expect-error - react specific API
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// Warm up the worker module graph before tests run. The first
// exports.default.fetch() triggers Vite module resolution for
// the entire dependency tree — in CI this can take >10s if done
// inside a test, causing spurious timeouts.
beforeAll(async () => {
  await exports.default.fetch("http://warmup/");
}, 30_000);

// Give DOs a moment to finish WebSocket close handlers before
// the module is invalidated between test files.
afterAll(() => new Promise((resolve) => setTimeout(resolve, 100)));
