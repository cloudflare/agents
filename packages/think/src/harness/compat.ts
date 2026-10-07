/**
 * `../think` with `Think` swapped for the harness-backed class.
 *
 * The harness compat run (`vitest.harness.config.ts`) points the test
 * agents' `../think` imports here, so the same test suite runs against
 * `./think`. Everything else is the real module.
 */
export * from "../think";
export { Think } from "./think";
