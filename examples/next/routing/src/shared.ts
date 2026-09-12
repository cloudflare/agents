/**
 * Wire contract shared by the Worker and the browser. This module must
 * stay dependency-free: `client.tsx` imports it, so anything it reaches
 * would be pulled into the browser bundle.
 */

/** Longest message a chat stores. Both sides bound against it. */
export const MAX_TEXT = 2_000;

/** Longest search term the hub accepts. */
export const MAX_QUERY = 200;
