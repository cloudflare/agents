import { exports } from "cloudflare:workers";
import { afterAll, afterEach, beforeAll } from "vitest";
import { server } from "./server";

// Start the MSW tripwire before any test. `onUnhandledRequest: "error"` turns
// an unexpected outbound fetch into a hard failure — this suite should touch
// only the in-isolate HTTP surface, never the real network.
beforeAll(() => {
  server.listen({ onUnhandledRequest: "error" });
});

// Warm up the worker module graph before the tests run. The first
// exports.default.fetch() forces the isolate to resolve the whole dependency
// tree (@cloudflare/think, @cloudflare/workspace, agents); doing it here rather
// than inside the first test keeps a cold start from eating a test's timeout
// budget.
beforeAll(async () => {
  await exports.default.fetch("http://warmup/");
}, 60_000);

// Drop any per-test handlers so tests can't leak request mocks into each other.
afterEach(() => {
  server.resetHandlers();
});

afterAll(() => {
  server.close();
});
