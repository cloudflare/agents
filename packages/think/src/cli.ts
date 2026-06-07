// Programmatic entry point for the Think CLI.
//
// This is consumed by the `create-think` package so it can reuse the exact
// scaffolding logic behind `think init`, while injecting its own remote
// template fetcher (degit). It intentionally has no side effects on import
// (unlike `./cli/index.ts`, which is the executable bin).

export { initCommand, type InitCommandOptions } from "./cli/init";
export {
  DEFAULT_TEMPLATE,
  formatTemplateList,
  isKnownTemplate,
  resolveTemplateName,
  THINK_TEMPLATES,
  type TemplateFetcher,
  type TemplateFetchRequest,
  type ThinkTemplateName
} from "./cli/templates";

/** The GitHub repo path that hosts the starter templates for remote fetches. */
export const THINK_TEMPLATES_REPO = "cloudflare/agents/think-starters";
