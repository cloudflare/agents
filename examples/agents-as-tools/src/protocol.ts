/**
 * Runtime-safe shared values for the browser bundle.
 *
 * Keep Worker-only imports out of this module. The client imports it directly,
 * so it should stay limited to plain constants and erased types.
 */

/**
 * The single Assistant DO name used by this single-user demo. A real app would
 * authenticate the user first and use their id.
 */
export const DEMO_USER = "demo";
