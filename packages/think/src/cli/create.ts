import yargs from "yargs";
import type { Argv } from "yargs";
import { hideBin } from "yargs/helpers";
import { initCommand } from "./init";
import { inspectCommand } from "./inspect";
import { stateCommand } from "./state";
import { studioCommand } from "./studio";
import { typesCommand } from "./types";

function connectionOptions<T>(cmd: Argv<T>) {
  return cmd
    .positional("agent", {
      type: "string",
      describe: "Agent id/alias (from the manifest) or a raw route segment"
    })
    .positional("instance", {
      type: "string",
      describe: "Agent instance name",
      default: "default"
    })
    .option("url", {
      type: "string",
      describe: "Remote origin, e.g. https://app.example.com (implies wss)"
    })
    .option("host", {
      type: "string",
      describe: "Local host[:port] (default: localhost:5173)"
    })
    .option("protocol", {
      type: "string",
      choices: ["ws", "wss"] as const,
      describe: "Override the WebSocket protocol"
    })
    .option("token", {
      type: "string",
      describe: "Auth token, sent as the `token` query param"
    })
    .option("query", {
      type: "string",
      array: true,
      describe: "Extra query params as key=value (repeatable)"
    })
    .option("root", {
      type: "string",
      describe: "Project root used to discover the Think manifest",
      default: process.cwd()
    })
    .option("route-prefix", {
      type: "string",
      describe: "Override the Think route prefix"
    });
}

export function createCli(argv = process.argv) {
  return yargs(hideBin(argv))
    .parserConfiguration({ "populate--": true })
    .scriptName("think")
    .usage("$0 <command> [options]")
    .command(
      "init [directory]",
      "Scaffold a new Think app from a starter template, or add Think to the current project",
      (cmd) =>
        cmd
          .positional("directory", {
            type: "string",
            describe:
              "Target directory to initialize. Omit to choose interactively."
          })
          .option("root", {
            type: "string",
            describe: "Base directory for initialization",
            default: process.cwd()
          })
          .option("name", {
            type: "string",
            describe: "Package and Worker name for the generated app"
          })
          .option("template", {
            type: "string",
            describe: "Starter template to scaffold (omit to choose)"
          })
          .option("ref", {
            type: "string",
            describe: "Git ref to fetch remote templates from"
          })
          .option("route-prefix", {
            type: "string",
            describe:
              "Think route prefix when adding Think to an existing project"
          })
          .option("yes", {
            alias: "y",
            type: "boolean",
            describe: "Use defaults and skip prompts",
            default: false
          })
          .option("install", {
            type: "boolean",
            describe: "Run npm install after writing files",
            default: true
          })
          .option("dry-run", {
            type: "boolean",
            describe: "Print files that would be written without writing them",
            default: false
          }),
      async (args) => {
        await initCommand({
          root: args.root,
          directory: args.directory,
          name: args.name,
          template: args.template,
          ref: args.ref,
          routePrefix: args.routePrefix,
          yes: args.yes,
          install: args.install,
          dryRun: args.dryRun
        });
      }
    )
    .command(
      "inspect",
      "Inspect the Think app manifest, routing, bindings, and diagnostics",
      (cmd) =>
        cmd
          .option("root", {
            type: "string",
            describe: "Project root to inspect",
            default: process.cwd()
          })
          .option("json", {
            type: "boolean",
            describe: "Print machine-readable JSON output",
            default: false
          })
          .option("route-prefix", {
            type: "string",
            describe: "Override the Think route prefix"
          })
          .option("allow-non-virtual-main", {
            type: "boolean",
            describe:
              "Do not report non-virtual Wrangler main as an error during inspection",
            default: false
          }),
      async (args) => {
        await inspectCommand({
          root: args.root,
          json: args.json,
          routePrefix: args.routePrefix,
          allowNonVirtualMain: args.allowNonVirtualMain
        });
      }
    )
    .command(
      "types",
      "Generate Think TypeScript declarations",
      (cmd) =>
        cmd
          .option("root", {
            type: "string",
            describe: "Project root to generate types for",
            default: process.cwd()
          })
          .option("types-file", {
            type: "string",
            describe: "Think declaration file to generate",
            default: "think.d.ts"
          })
          .option("all", {
            type: "boolean",
            describe: "Also run Wrangler type generation before Think typegen",
            default: false
          })
          .option("wrangler-env-file", {
            type: "string",
            describe: "Wrangler env declaration file to generate with --all",
            default: "env.d.ts"
          })
          .option("route-prefix", {
            type: "string",
            describe: "Override the Think route prefix"
          })
          .option("dry-run", {
            type: "boolean",
            describe: "Print files that would be written without writing them",
            default: false
          })
          .option("check", {
            type: "boolean",
            describe: "Check generated Think types without modifying files",
            default: false
          }),
      async (args) => {
        await typesCommand({
          root: args.root,
          typesFile: args.typesFile,
          wranglerEnvFile: args.wranglerEnvFile,
          routePrefix: args.routePrefix,
          all: args.all,
          dryRun: args.dryRun,
          check: args.check,
          wranglerArgs: Array.isArray(args["--"]) ? args["--"].map(String) : []
        });
      }
    )
    .command(
      "studio [agent] [instance]",
      "Launch Think Studio — a local web app to chat with and inspect a running Think instance (local or remote)",
      (cmd) =>
        connectionOptions(cmd)
          .option("port", {
            type: "number",
            describe: "Port for the local Studio server",
            default: 4321
          })
          .option("open", {
            type: "boolean",
            describe: "Open the browser automatically",
            default: true
          }),
      async (args) => {
        await studioCommand({
          agent: args.agent as string | undefined,
          instance: args.instance,
          url: args.url,
          host: args.host,
          protocol: args.protocol,
          token: args.token,
          query: args.query,
          root: args.root,
          routePrefix: args.routePrefix,
          port: args.port,
          open: args.open
        });
      }
    )
    .command(
      "state <agent> [instance]",
      "Print a running Think agent's identity, state, and recent history (read-only)",
      (cmd) =>
        connectionOptions(cmd)
          .option("json", {
            type: "boolean",
            describe: "Print machine-readable JSON output",
            default: false
          })
          .option("limit", {
            type: "number",
            describe: "Number of recent messages to include",
            default: 10
          }),
      async (args) => {
        await stateCommand({
          agent: args.agent as string,
          instance: args.instance,
          url: args.url,
          host: args.host,
          protocol: args.protocol,
          token: args.token,
          query: args.query,
          root: args.root,
          routePrefix: args.routePrefix,
          json: args.json,
          limit: args.limit
        });
      }
    )
    .demandCommand(1, "Please provide a command")
    .strict()
    .help();
}
