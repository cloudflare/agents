import { exports } from "cloudflare:workers";
import { afterAll, beforeAll } from "vitest";

beforeAll(async () => {
  await exports.default.fetch("http://warmup/");
}, 30_000);

afterAll(() => new Promise((resolve) => setTimeout(resolve, 100)));
