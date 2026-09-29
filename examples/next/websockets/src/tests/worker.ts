// Test worker: re-export the production classes. Must not import
// cloudflare:test — vitest boots this module graph via wrangler.
export { RoomObject } from "../index";
export { default } from "../index";
