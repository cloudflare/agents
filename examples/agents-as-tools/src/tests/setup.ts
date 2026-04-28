import { afterAll, beforeAll } from "vitest";
import { exports } from "cloudflare:workers";

// Warm up the worker module graph before tests run. The first fetch
// through the test worker triggers Vite's module resolution for the
// entire dependency tree (Think, agents, agents/chat, kumo, etc.).
// On a cold CI runner that can take >10s, which would otherwise blow
// the first test's per-test timeout.
beforeAll(async () => {
  await exports.default.fetch("http://warmup/");
}, 30_000);

// Give DOs a moment to finish WebSocket close handlers before the
// module is invalidated between test files.
afterAll(() => new Promise((resolve) => setTimeout(resolve, 100)));
