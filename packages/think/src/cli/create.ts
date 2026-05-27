import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { inspectCommand } from "./inspect";
import { typesCommand } from "./types";

export function createCli(argv = process.argv) {
  return yargs(hideBin(argv))
    .parserConfiguration({ "populate--": true })
    .scriptName("think")
    .usage("$0 <command> [options]")
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
    .demandCommand(1, "Please provide a command")
    .strict()
    .help();
}
