import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      // Workers runtime tests (Durable Objects, facets, WebSocket protocol)
      "tests/vitest.config.ts",
      // Node.js unit tests (pure TypeScript — AgentLoop, context trimming)
      {
        test: {
          name: "think-node",
          include: ["tests/*.node.test.ts"],
          environment: "node"
        }
      }
    ]
  }
});
