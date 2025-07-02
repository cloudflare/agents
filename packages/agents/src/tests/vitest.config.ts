import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    deps: {
      optimizer: {
        ssr: {
          include: [
            // for some reason, mcp sdk 1.13.3 breaks without these
            "@modelcontextprotocol/sdk/server/index.js",
            "@modelcontextprotocol/sdk/server/mcp.js",
            "@modelcontextprotocol/sdk/shared/transport.js",
            "@modelcontextprotocol/sdk/types.js",
            "@modelcontextprotocol/sdk/client/index.js",
            "@modelcontextprotocol/sdk/client/auth.js",
            "@modelcontextprotocol/sdk/client/sse.js",
            "@modelcontextprotocol/sdk/shared/protocol.js",
          ],
        },
      },
    },
    poolOptions: {
      workers: {
        isolatedStorage: false,
        singleWorker: true,
        wrangler: {
          configPath: "./wrangler.jsonc",
        },
      },
    },
  },
});
