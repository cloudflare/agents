/**
 * The `skills` namespace Think re-exports: `agents/skills`, plus the
 * experimental script runner from `agents/skills/runner` so `skills.runner()`
 * keeps working for Think users.
 *
 * The exports are listed by name: the declaration bundler drops
 * `export * from` an external package inside a namespace.
 *
 * @module
 */
export {
  DEFAULT_WORKSPACE_SKILLS_ROOT,
  formatSkill,
  formatSkillDiagnostic,
  fromManifest,
  InvalidSkillError,
  InvalidSkillResourcePathError,
  isModelInvocable,
  loadSkillCatalog,
  manifest,
  parseSkill,
  parseSkillName,
  parseSkillResourcePath,
  r2,
  renderSkillResource,
  SkillParseError,
  SkillResourceNotFoundError,
  SkillSourceError,
  UnknownSkillError,
  workspace
} from "agents/skills";
export type {
  InvalidSkill,
  InvalidSkillCatalogEntry,
  ListedSkill,
  LoadSkillCatalogOptions,
  ParseSkillOptions,
  R2SkillSourceOptions,
  Skill,
  SkillCatalog,
  SkillCatalogEntry,
  SkillCatalogResource,
  SkillDiagnostic,
  SkillListing,
  SkillManifest,
  SkillManifestEntry,
  SkillManifestResource,
  SkillName,
  SkillParseErrorCode,
  SkillParseIssue,
  SkillResource,
  SkillResourceError,
  SkillResourceInfo,
  SkillResourceKind,
  SkillResourcePath,
  SkillResult,
  SkillRunContext,
  SkillScriptContext,
  SkillScriptFile,
  SkillScriptRequest,
  SkillScriptRunner,
  SkillScriptWorkspace,
  SkillSource,
  SkillWorkspace,
  WorkspaceSkillSourceOptions
} from "agents/skills";
export { runner } from "agents/skills/runner";
export type { WorkerSkillScriptRunnerOptions } from "agents/skills/runner";
