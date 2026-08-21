import { DurableObject } from "cloudflare:workers";
import { expectTypeOf } from "vitest";
import { Lifecycle, type DurableObjectCapability } from "../lifecycle";
import { MCPClientManager } from "../mcp/client";

expectTypeOf<MCPClientManager>().toMatchTypeOf<DurableObjectCapability>();

class McpCapabilityTypeProbe extends DurableObject {
  readonly mcp = new MCPClientManager("type-probe", "1.0.0", {
    storage: this.ctx.storage
  });

  readonly lifecycle = Lifecycle.install(this).use(this.mcp);
}

expectTypeOf<McpCapabilityTypeProbe["mcp"]>().toEqualTypeOf<MCPClientManager>();
expectTypeOf<McpCapabilityTypeProbe["lifecycle"]>().toEqualTypeOf<Lifecycle>();
