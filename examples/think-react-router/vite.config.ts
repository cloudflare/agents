import { viteBuildTask } from "../../scripts/vite-task-cache";
import { defineConfig, lazyPlugins } from "vite-plus";

export default defineConfig({
  plugins: lazyPlugins(async () => {
    const [{ cloudflare }, { reactRouter }, { think }] = await Promise.all([
      import("@cloudflare/vite-plugin"),
      import("@react-router/dev/vite"),
      import("@cloudflare/think/vite")
    ]);

    return [
      cloudflare({ viteEnvironment: { name: "ssr" } }),
      reactRouter(),
      think({ routePrefix: "/api/agents", allowNonVirtualMain: true })
    ];
  }),
  run: {
    tasks: {
      "build:vite": viteBuildTask
    }
  }
});
