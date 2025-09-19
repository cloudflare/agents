import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import chalk from "chalk";
import { defineConfig } from "vite";
import path from "path";

export default defineConfig({
  plugins: [
    react(),
    cloudflare(),

    {
      configureServer(server) {
        server.middlewares.use((req, _res, next) => {
          const timeString = new Date().toLocaleTimeString();
          console.log(
            `[${chalk.blue(timeString)}] ${chalk.green(
              req.method
            )} ${chalk.yellow(req.url)}`
          );
          next();
        });
      },
      name: "requestLogger"
    }
  ],
  resolve: {
    alias: {
      // Force React 19 from workspace root
      react: path.resolve("../../node_modules/react"),
      "react-dom": path.resolve("../../node_modules/react-dom")
    }
  }
});
