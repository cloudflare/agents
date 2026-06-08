import { viteBuildTask } from "../../scripts/vite-task-cache";
import { defineConfig, lazyPlugins } from "vite-plus";

export default defineConfig({
  plugins: lazyPlugins(async () => {
    const [{ cloudflare }, { tanstackStart }, { default: react }, { think }] =
      await Promise.all([
        import("@cloudflare/vite-plugin"),
        import("@tanstack/react-start/plugin/vite"),
        import("@vitejs/plugin-react"),
        import("@cloudflare/think/vite")
      ]);

    return [
      cloudflare({ viteEnvironment: { name: "ssr" } }),
      tanstackStart(),
      react(),
      think({ routePrefix: "/api/agents", allowNonVirtualMain: true })
    ];
  }),
  run: {
    tasks: {
      "build:vite": viteBuildTask
    }
  }
});
