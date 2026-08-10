import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import agents from "agents/vite";
import { defineConfig } from "vite";

export default defineConfig(({ command }) => {
  const persistPath = process.env.RLM_DEV_PERSIST_PATH?.trim();

  return {
    plugins: [
      agents(),
      react(),
      cloudflare(
        command === "serve"
          ? {
              ...(persistPath ? { persistState: { path: persistPath } } : {}),
              config(config) {
                config.secrets = { required: [] };
              }
            }
          : undefined
      ),
      tailwindcss()
    ]
  };
});
