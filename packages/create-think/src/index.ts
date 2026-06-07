#!/usr/bin/env node
import {
  initCommand,
  THINK_TEMPLATES,
  THINK_TEMPLATES_REPO,
  type TemplateFetchRequest
} from "@cloudflare/think/cli";
import tiged from "tiged";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";

/**
 * Remote template fetcher. Pulls a starter folder out of the agents repo with
 * degit (tiged). `create-think` injects this so it can scaffold from the
 * published templates when no local copy is available.
 */
async function fetchTemplate({
  template,
  ref,
  dest
}: TemplateFetchRequest): Promise<void> {
  const source = `${THINK_TEMPLATES_REPO}/${template}#${ref}`;
  const emitter = tiged(source, { disableCache: true, mode: "tar" });
  await emitter.clone(dest);
}

async function main(): Promise<void> {
  const templateList = THINK_TEMPLATES.map((t) => t.name).join(", ");
  const args = await yargs(hideBin(process.argv))
    .scriptName("create-think")
    .usage("$0 [directory] [options]")
    .option("template", {
      alias: "t",
      type: "string",
      describe: `Starter template (${templateList})`
    })
    .option("name", {
      type: "string",
      describe: "Package and Worker name for the generated app"
    })
    .option("ref", {
      type: "string",
      describe: "Git ref to fetch templates from",
      default: "main"
    })
    .option("install", {
      type: "boolean",
      describe: "Run npm install after scaffolding",
      default: true
    })
    .option("yes", {
      alias: "y",
      type: "boolean",
      describe: "Use defaults and skip prompts",
      default: false
    })
    .option("dry-run", {
      type: "boolean",
      describe: "Show what would be created without writing files",
      default: false
    })
    .help()
    .parse();

  const directory = args._[0] != null ? String(args._[0]) : undefined;

  await initCommand({
    directory,
    template: args.template,
    name: args.name,
    ref: args.ref,
    yes: args.yes,
    install: args.install,
    dryRun: args.dryRun,
    fetchTemplate
  });
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
