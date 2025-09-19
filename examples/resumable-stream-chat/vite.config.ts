import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import chalk from "chalk";
import { defineConfig } from "vite";

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
  ]
});
