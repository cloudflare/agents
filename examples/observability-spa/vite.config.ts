import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, type Plugin } from "vite";
import chalk from "chalk";

// For the client environment we want to include an additional entrypoint
// for the observability page.
const obsEntrypointPlugin: Plugin = {
  name: "obs-entrypoint",
  applyToEnvironment(environment) {
    return environment.name === "client";
  },
  options(options) {
    options.input = ["index.html", "@obs.html"];
  },
};

export default defineConfig(() => {
  return {
    plugins: [
      react(),
      cloudflare(),
      tailwindcss(),
      obsEntrypointPlugin,
      {
        name: "requestLogger",
        configureServer(server) {
          server.middlewares.use((req, res, next) => {
            const timeString = new Date().toLocaleTimeString();
            console.log(
              `[${chalk.blue(timeString)}] ${chalk.green(
                req.method
              )} ${chalk.yellow(req.url)}`
            );
            next();
          });
        },
      },
    ],
  };
});
