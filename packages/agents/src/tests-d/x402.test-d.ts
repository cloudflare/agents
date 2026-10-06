import { McpServer as LegacyMcpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RegisteredTool as LegacyRegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  McpServer,
  type RegisteredTool,
  type ServerContext
} from "@modelcontextprotocol/server";
import { withX402, type X402Config } from "agents/x402";
import { z } from "zod";

const cfg: X402Config = {
  network: "base-sepolia",
  recipient: "0x000000000000000000000000000000000000dEaD"
};

// SDK v2: the callback receives the v2 ServerContext.
const v2 = withX402(new McpServer({ name: "v2", version: "1.0.0" }), cfg);
const v2Tool: RegisteredTool = v2.paidTool(
  "t",
  "d",
  0.01,
  { a: z.string() },
  {},
  async ({ a }, ctx) => {
    const typedCtx: ServerContext = ctx;
    void typedCtx;
    return { content: [{ type: "text", text: a }] };
  }
);
void v2Tool;

// SDK v1: a direct call keeps the v1 types.
const v1 = withX402(new LegacyMcpServer({ name: "v1", version: "1.0.0" }), cfg);
const v1Tool: LegacyRegisteredTool = v1.paidTool(
  "t",
  "d",
  0.01,
  { a: z.string() },
  {},
  async ({ a }) => ({ content: [{ type: "text", text: a }] })
);
void v1Tool;

// SDK v1: a generic wrapper still resolves the callback type.
function register<T extends LegacyMcpServer>(server: T) {
  return withX402(server, cfg).paidTool(
    "t",
    "d",
    0.01,
    { a: z.string() },
    {},
    async ({ a }, extra) => {
      void extra.signal;
      return { content: [{ type: "text", text: a }] };
    }
  );
}
void register;

// SDK v1: a field typed from ReturnType keeps the v1 paidTool.
declare const fromReturnType: ReturnType<typeof withX402>;
fromReturnType.paidTool(
  "t",
  "d",
  0.01,
  { a: z.string() },
  {},
  async ({ a }) => ({ content: [{ type: "text", text: a }] })
);
