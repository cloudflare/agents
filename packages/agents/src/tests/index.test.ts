import {
  createExecutionContext,
  env,
  // waitOnExecutionContext
} from "cloudflare:test";
import { describe, expect, it } from "vitest";

import worker, { type Env } from "./worker";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

describe("test", () => {
  it("can be connected with a url", async () => {
    const ctx = createExecutionContext();
    const request = new Request("http://example.com/parties/stateful/123");
    const response = await worker.fetch(request, env, ctx);
    expect(await response.text()).toEqual("Hello, world!");
  });
});
