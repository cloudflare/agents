/**
 * What every harness shares. Each harness, such as `agents/harness/pi`,
 * builds its extensions on these types.
 *
 * @experimental The API may change between releases.
 */
export type {
  Extension,
  ExtensionContext,
  ExtensionDraft,
  Extensions,
  ExtensionState,
  ToolContext
} from "./extension";
