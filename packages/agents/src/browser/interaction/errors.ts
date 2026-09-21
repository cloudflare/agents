/**
 * The interaction error taxonomy: machine codes plus fix-oriented teaching.
 * Both provider lanes throw these — the code is for programs, the message is
 * for the model, and every message says what to do next, not just what broke.
 */

/** Every machine code an interaction verb can fail with. */
export const INTERACTION_ERROR_CODES = [
  "STALE_REF",
  "TARGET_NOT_FOUND",
  "NOT_INTERACTIVE",
  "DIALOG_BLOCKED",
  "SESSION_RESTARTED",
  "NAVIGATION_TIMEOUT"
] as const;

export type InteractionErrorCode = (typeof INTERACTION_ERROR_CODES)[number];

/**
 * One fix-oriented teaching sentence per code — the canonical wording both
 * lanes use, so the model gets identical guidance whatever engine is
 * underneath. Corrective (Playwright posture), with the cause detail
 * preserved rather than erased.
 */
export const INTERACTION_ERROR_TEACHING: Record<InteractionErrorCode, string> =
  {
    STALE_REF:
      "This ref is from an older snapshot and no longer matches a live element — call snapshot() again and use a fresh ref.",
    TARGET_NOT_FOUND:
      "No element matched this target — call snapshot() to see the current page; if it is genuinely absent there, escalate: screenshot() for visual layout, evaluate() for raw DOM/HTML.",
    NOT_INTERACTIVE:
      "The element exists but cannot be interacted with right now — check detail for the cause, then scroll it into view, wait for it to enable, or pick a different target from a fresh snapshot().",
    DIALOG_BLOCKED:
      'A dialog is open and blocks the page — call handleDialog("accept") or handleDialog("dismiss") first, then retry the action.',
    SESSION_RESTARTED:
      "The browser session was restarted and all page state was lost (tabs, navigation, cookies, logins). Do not repeat prior actions blindly — verify the current state with snapshot() and redo any setup that matters.",
    NAVIGATION_TIMEOUT:
      "Navigation did not complete in time — the page may be slow or unreachable. Check where you are with snapshot() before retrying, or waitFor({ text }) for content on slow pages."
  };

export interface BrowserInteractionErrorOptions {
  /** Replace the default teaching sentence for this code. */
  message?: string;
  /**
   * The preserved cause — e.g. the actionability check that failed for
   * `NOT_INTERACTIVE`. Appended to the message so one read has both.
   */
  detail?: string;
}

/**
 * The wire shape of an interaction error: what survives serialization across
 * the sandbox boundary. {@link isBrowserInteractionError} recognizes this
 * shape structurally, because `instanceof` dies with the prototype.
 */
export interface BrowserInteractionErrorShape {
  name: "BrowserInteractionError";
  code: InteractionErrorCode;
  message: string;
  detail?: string;
}

export class BrowserInteractionError extends Error {
  readonly code: InteractionErrorCode;
  readonly detail?: string;

  constructor(
    code: InteractionErrorCode,
    options: BrowserInteractionErrorOptions = {}
  ) {
    const base = options.message ?? INTERACTION_ERROR_TEACHING[code];
    super(options.detail ? `${base} (detail: ${options.detail})` : base);
    this.name = "BrowserInteractionError";
    this.code = code;
    this.detail = options.detail;
  }

  toJSON(): BrowserInteractionErrorShape {
    return {
      name: "BrowserInteractionError",
      code: this.code,
      message: this.message,
      detail: this.detail
    };
  }
}

/**
 * Structural guard — works on live instances and on serialized copies that
 * crossed the sandbox boundary and lost their prototype.
 */
export function isBrowserInteractionError(
  value: unknown
): value is BrowserInteractionErrorShape {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as {
    name?: unknown;
    code?: unknown;
    message?: unknown;
    detail?: unknown;
  };
  return (
    candidate.name === "BrowserInteractionError" &&
    typeof candidate.message === "string" &&
    typeof candidate.code === "string" &&
    (candidate.detail === undefined || typeof candidate.detail === "string") &&
    (INTERACTION_ERROR_CODES as readonly string[]).includes(candidate.code)
  );
}
