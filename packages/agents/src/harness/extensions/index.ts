/**
 * Portable harness extensions: one extension format that runs on every
 * harness. Write an extension once with `defineExtension`, then hand it to
 * a harness adapter such as `piExtensions` from `agents/harness/pi`.
 *
 * @experimental The API may change between releases.
 */
export {
  defineExtension,
  defineTool,
  type Cleanup,
  type Extension,
  type ExtensionContext,
  type ExtensionFeature,
  type InstructionsDomain,
  type InstructionsDraft,
  type Registration,
  type SkillDomain,
  type SkillDraft,
  type Tool,
  type ToolAfterEvent,
  type ToolBeforeEvent,
  type ToolCallContext,
  type ToolContentPart,
  type ToolDomain,
  type ToolDraft,
  type ToolHookEvents,
  type ToolReplay,
  type ToolResult,
  type TransformDomain
} from "./extension";
export {
  ExtensionAlreadyInstalled,
  ExtensionFeatureUnsupported,
  ExtensionHost,
  ExtensionSetupFailed,
  type ExtensionHostOptions,
  type ExtensionReport,
  type ExtensionSnapshot
} from "./host";
export {
  jsonSchema,
  type InferInput,
  type JsonObject,
  type JsonValue,
  type SchemaIssue,
  type ToolInputSchema
} from "./schema";
