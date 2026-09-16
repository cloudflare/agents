import type {
  ClaudeCodeProtocolTestObject,
  LiveDaemonTestObject
} from "./worker";

/** Bindings the test wrangler config adds on top of the example's own. */
interface HarnessTestBindings {
  CLAUDE_CODE_PROTOCOL_TEST: DurableObjectNamespace<ClaudeCodeProtocolTestObject>;
  LIVE_DAEMON_TEST: DurableObjectNamespace<LiveDaemonTestObject>;
  HARNESSD_URL: string;
  HARNESSD_SECRET: string;
}

declare global {
  interface Env extends HarnessTestBindings {}
  namespace Cloudflare {
    interface Env extends HarnessTestBindings {}
  }
}

export {};
