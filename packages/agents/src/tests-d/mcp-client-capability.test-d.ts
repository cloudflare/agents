import { expectTypeOf } from "vitest";
import type { DurableObjectCapability } from "../lifecycle";
import { MCPClientManager, type MCPClientManagerOptions } from "../mcp/client";

const options = {
  env: {} as Cloudflare.Env
} satisfies MCPClientManagerOptions;

const mcp = new MCPClientManager("my-object", "1.0.0", options);
expectTypeOf(mcp).toMatchTypeOf<DurableObjectCapability>();

new MCPClientManager("my-object", "1.0.0");

new MCPClientManager("my-object", "1.0.0", {
  // @ts-expect-error Lifecycle supplies capability storage.
  storage: {} as DurableObjectStorage
});
