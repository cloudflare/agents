import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import chalk from "chalk";
import { defineConfig, type Plugin } from "vite";

// For the client environment we want to include an additional entrypoint
// for the observability page.
const obsEntrypointPlugin: Plugin = {
  applyToEnvironment(environment) {
    return environment.name === "client";
  },
  name: "obs-entrypoint",
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
        name: "requestLogger",
      },
    ],
  };
});
