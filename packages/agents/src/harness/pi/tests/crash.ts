/**
 * The reason a test crashes an object with. Aborting an object rejects the
 * work it had in flight with this, which is the crash being simulated, so
 * vitest.config.ts ignores exactly these rejections and nothing else.
 */
export const CRASH_REASON = "crashed by the test";
