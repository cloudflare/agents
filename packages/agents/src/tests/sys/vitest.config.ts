import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";
import { readFileSync } from "node:fs";
import type { Plugin } from "vite";

// Plugin to handle HTML imports as text
function htmlTextPlugin(): Plugin {
  return {
    name: "html-text-plugin",
    enforce: "pre",
    resolveId(id) {
      if (id.endsWith(".html") || id.includes(".html?")) {
        // Return a virtual module ID
        return `\0virtual:${id.split("?")[0]}`;
      }
      return null;
    },
    load(id) {
      if (id.startsWith("\0virtual:") && id.endsWith(".html")) {
        const realPath = id.replace("\0virtual:", "");
        try {
          const content = readFileSync(realPath, "utf-8");
          return `export default ${JSON.stringify(content)};`;
        } catch {
          return `export default "<html><body>Mock Dashboard</body></html>";`;
        }
      }
      return null;
    }
  };
}

export default defineWorkersConfig({
  plugins: [htmlTextPlugin()],
  test: {
    deps: {
      inline: [/agents\/src\/sys/],
      optimizer: {
        ssr: {
          include: ["ajv"]
        }
      }
    },
    poolOptions: {
      workers: {
        isolatedStorage: false,
        singleWorker: true,
        wrangler: {
          configPath: "./wrangler.jsonc"
        }
      }
    }
  }
});
