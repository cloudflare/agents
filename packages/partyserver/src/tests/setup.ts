import { beforeAll } from "vitest";
import { exports } from "cloudflare:workers";

// Warm up the worker module graph so the first test in each file doesn't
// time out waiting for Vite to lazy-resolve modules on cold start.
beforeAll(async () => {
  await exports.default.fetch(new Request("http://warmup/"));
}, 30_000);
