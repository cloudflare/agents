export type {
  ActionEnvelope,
  ActionTarget,
  BrowserSnapshot,
  BrowserVerbs,
  ClickOptions,
  ConsoleDelta,
  ConsoleMessage,
  ConsoleReadOptions,
  DialogFact,
  DownloadFact,
  ElementRef,
  HandleDialogOptions,
  InteractionProvider,
  InteractionVerbs,
  NavigateOptions,
  ProviderActionResult,
  RequestReadOptions,
  RequestRecord,
  ScreenshotOptions,
  ScreenshotResult,
  ScrollOptions,
  SettleTimeoutReason,
  SnapshotNode,
  TabInfo,
  TabsChanged,
  TypeOptions,
  WaitForCondition
} from "./contract";
export {
  BrowserInteractionError,
  INTERACTION_ERROR_CODES,
  INTERACTION_ERROR_TEACHING,
  isBrowserInteractionError,
  type BrowserInteractionErrorOptions,
  type BrowserInteractionErrorShape,
  type InteractionErrorCode
} from "./errors";
export { VERB_DESCRIPTIONS, VERB_NAMES, type VerbName } from "./verbs";
