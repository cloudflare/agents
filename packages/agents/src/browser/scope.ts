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
