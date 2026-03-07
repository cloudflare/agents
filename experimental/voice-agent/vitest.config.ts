import { defineConfig, loadEnv } from "vite";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode ?? "test", process.cwd(), "");
  return {
    test: {
      include: ["src/__tests__/**/*.test.ts"],
      testTimeout: 15000,
      env
    }
  };
});
