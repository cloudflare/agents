// Agent Skills (https://agentskills.io): parse `SKILL.md`, load skills from
// a Computer Workspace, R2, or a manifest, and expose them to a model.

export {
  formatSkill,
  isModelInvocable,
  parseSkill,
  parseSkillName,
  SkillParseError
} from "./skill";
export type {
  ParseSkillOptions,
  Skill,
  SkillName,
  SkillParseErrorCode
} from "./skill";
export {
  InvalidSkillResourcePathError,
  parseSkillResourcePath
} from "./resource";
export type {
  SkillResource,
  SkillResourceInfo,
  SkillResourceKind,
  SkillResourcePath
} from "./resource";
export type { SkillResult } from "./result";
export { SkillResourceNotFoundError, SkillSourceError } from "./source";
export type {
  InvalidSkill,
  ListedSkill,
  SkillListing,
  SkillSource
} from "./source";
export { DEFAULT_WORKSPACE_SKILLS_ROOT, workspace } from "./workspace";
export type { SkillWorkspace, WorkspaceSkillSourceOptions } from "./workspace";
export { r2 } from "./r2";
export type { R2SkillSourceOptions } from "./r2";
export { fromManifest, manifest } from "./manifest";
export type {
  SkillManifest,
  SkillManifestEntry,
  SkillManifestResource
} from "./manifest";
export {
  formatSkillDiagnostic,
  loadSkillCatalog,
  renderSkillResource,
  UnknownSkillError
} from "./catalog";
export type {
  SkillCatalog,
  SkillCatalogEntry,
  SkillCatalogResource,
  SkillDiagnostic,
  SkillResourceError
} from "./catalog";
export { createSkillTools } from "./ai-sdk";
export type { SkillToolsOptions } from "./ai-sdk";
export { runner } from "./runner";
export type { WorkerSkillScriptRunnerOptions } from "./runner";
export type {
  SkillRunContext,
  SkillScriptContext,
  SkillScriptFile,
  SkillScriptRequest,
  SkillScriptRunner
} from "./script";
export type { SkillScriptWorkspace } from "./script-workspace";
