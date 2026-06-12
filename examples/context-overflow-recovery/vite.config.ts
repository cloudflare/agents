import { viteBuildTask } from "../../scripts/vite-task-cache";
import { defineConfig, lazyPlugins } from "vite-plus";

export default defineConfig({
  plugins: lazyPlugins(async () => {
    const [
      { cloudflare },
      { default: tailwindcss },
      { default: react },
      { default: agents }
    ] = await Promise.all([
      import("@cloudflare/vite-plugin"),
      import("@tailwindcss/vite"),
      import("@vitejs/plugin-react"),
      import("agents/vite")
    ]);

    return [agents(), react(), cloudflare(), tailwindcss()];
  }),
  run: {
    tasks: {
      "build:vite": viteBuildTask
    }
  }
});
