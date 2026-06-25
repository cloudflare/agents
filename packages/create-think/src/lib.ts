// Programmatic entry point for the create-think scaffolder.
//
// This is consumed by `@cloudflare/think` so `think init --template` (and new
// projects started outside an existing app) can reuse the exact scaffolding
// logic behind `npm create think`, without `create-think` depending on the
// framework. It has no side effects on import (unlike `./index.ts`, which is
// the executable bin).

export {
  initCommand,
  looksLikeThinkApp,
  type InitCommandOptions
} from "./init";
export {
  fileExists,
  gitOutcomeMessage,
  initializeGit,
  packageName,
  readTextIfExists,
  runNpmInstall,
  type GitInitOutcome
} from "./cli-utils";
export {
  DEFAULT_TEMPLATE,
  DEFAULT_TEMPLATE_REF,
  formatTemplateList,
  isKnownTemplate,
  resolveTemplateName,
  THINK_TEMPLATES,
  THINK_TEMPLATES_REPO,
  type TemplateFetcher,
  type TemplateFetchRequest,
  type ThinkTemplateName
} from "./templates";
