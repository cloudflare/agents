/**
 * Portable harness extensions: one extension format that runs on every
 * harness. An extension is a function of its context; pass an array of
 * them to a harness, such as `new PiHarness({ extensions })`.
 *
 * @experimental The API may change between releases.
 */
export {
  isNativeTool,
  tool,
  type Cleanup,
  type Command,
  type CommandDomain,
  type CommandDraft,
  type CommandResult,
  type EventDomain,
  type Extension,
  type ExtensionContext,
  type ExtensionFeature,
  type ExtensionSession,
  type ExtensionStorage,
  type HarnessEvents,
  type InstructionsDomain,
  type InstructionsDraft,
  type NativeTool,
  type NativeToolHandle,
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
  type ToolEntry,
  type ToolHookEvents,
  type ToolReplay,
  type ToolResult,
  type TransformDomain,
  type UserReply,
  type UserRequest
} from "./extension";
export {
  ExtensionAlreadyInstalled,
  ExtensionFeatureUnsupported,
  ExtensionHost,
  ExtensionSetupFailed,
  type DomainName,
  type ExtensionHostOptions,
  type ExtensionReport,
  type ExtensionSnapshot
} from "./host";
export {
  RequestStore,
  type PendingRequest,
  type ReplyRejected
} from "./requests";
export {
  jsonSchema,
  type InferInput,
  type JsonObject,
  type JsonValue,
  type SchemaIssue,
  type ToolInputSchema
} from "./schema";
export {
  deleteSessionStorage,
  extensionStorage,
  memoryKeyValueStore,
  type KeyValueStore
} from "./storage";
