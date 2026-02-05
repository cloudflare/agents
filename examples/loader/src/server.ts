/**
 * Main entry point for the Think Agent (Project Think).
 *
 * This file re-exports everything from server-without-browser.ts and adds BrowserLoopback.
 * We use this separation because @cloudflare/playwright requires node:child_process
 * which is not available in vitest-pool-workers test environment.
 *
 * - server-without-browser.ts: Base server, used for testing (no browser)
 * - server.ts: Production server with browser automation (this file)
 */

// Re-export all named exports from the base server
export * from "./server-without-browser";

// Re-export the default export (the Worker fetch handler)
export { default } from "./server-without-browser";

// Add BrowserLoopback for production use
// This import will fail in vitest-pool-workers but works in actual Workers runtime
export { BrowserLoopback } from "./loopbacks/browser";
