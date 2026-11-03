/**
 * Browser scopes: who is driving a shared `Browser`. Sessions with the same
 * scope share an active tab (and, when they lock, a lock); each scope
 * keeps its own. Cookies and logins are shared by every scope.
 */

/**
 * The scope used when a caller doesn't pick one: every caller that leaves
 * `scope` out shares this one active tab. See `BrowserConnectOptions`.
 */
export const DEFAULT_BROWSER_SCOPE = "shared";

/**
 * The scope for one conversation: `conversation:<id>`. pi's `browserTool`
 * gives each conversation this scope by default, so app code that opens
 * sessions with the same scope (a Workspace's `codemode:browser`, say) lands
 * in the same tab as the tool. pi's conversation ids are numbers: pass
 * `String(conversationId)`.
 *
 * Throws on a missing or empty id rather than returning
 * `"conversation:undefined"`, which would quietly put every conversation
 * without an id in one tab.
 *
 * @experimental The API surface may change before stabilizing.
 */
export function conversationScope(id: string): string {
  if (typeof id !== "string" || id === "") {
    throw new Error(
      `conversationScope needs a conversation id, got ${String(id)}.`
    );
  }
  return `conversation:${id}`;
}
