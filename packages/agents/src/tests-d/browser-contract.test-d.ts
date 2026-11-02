import { expectTypeOf } from "vitest";
import {
  Browser,
  browserRun,
  conversationScope,
  type BrowserFunction,
  type BrowserFunctionDocs,
  type BrowserSessionReport
} from "../browser";

declare const env: { BROWSER: Fetcher };

/**
 * The browser contract a Workspace module types by shape, with no runtime
 * dependency on agents (Computer's `codemode:browser`). A change here breaks
 * those modules, so keep it deliberate.
 */
interface WorkspaceBrowser {
  functionDocs(): { functions: string; rules: string[] };
  session(options: { scope: string; lock: true }): WorkspaceBrowserSession;
}

interface WorkspaceBrowserSession {
  readonly functions: Readonly<
    Record<string, (input: unknown) => Promise<unknown>>
  >;
  lock(options?: { signal?: AbortSignal }): Promise<void>;
  readonly waitedForLockMs: number;
  close(): Promise<{ notices: string[] } | undefined>;
}

const browser = new Browser({ provider: browserRun(env.BROWSER) });
expectTypeOf(browser).toExtend<WorkspaceBrowser>();

expectTypeOf(browser.functionDocs()).toEqualTypeOf<BrowserFunctionDocs>();
expectTypeOf<BrowserFunction>().toEqualTypeOf<
  (input: unknown) => Promise<unknown>
>();
expectTypeOf<BrowserSessionReport["notices"]>().toEqualTypeOf<string[]>();

expectTypeOf(conversationScope).toEqualTypeOf<(id: string) => string>();
