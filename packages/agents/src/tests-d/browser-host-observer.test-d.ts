import { expectTypeOf } from "vitest";
import {
  Browser,
  browserRun,
  type BrowserHostObserver,
  type BrowserHostTab,
  type CdpEvent
} from "../browser";

declare const env: { BROWSER: Fetcher };

// The shapes a hook may take: sync or async, with or without a cleanup,
// and a cleanup that is sync or async.
const shapes: BrowserHostObserver[] = [
  () => {},
  async () => {},
  () => () => {},
  () => async () => {},
  async () => () => {},
  async () => async () => {},
  (tab) => {
    void tab.send("Network.enable");
  },
  async (tab) => {
    await tab.send("Network.enable");
  }
];
new Browser({ provider: browserRun(env.BROWSER), hostObserver: shapes[0] });

// A hook that returns anything else, such as a command's promise, is a
// type error: write an async block body that awaits it.
// @ts-expect-error Promise<unknown> is not a cleanup.
const returnsSend: BrowserHostObserver = (tab) => tab.send("Page.enable");
void returnsSend;

expectTypeOf<BrowserHostTab["targetId"]>().toEqualTypeOf<string>();
expectTypeOf<BrowserHostTab["scope"]>().toEqualTypeOf<string>();
expectTypeOf<BrowserHostTab["sessionId"]>().toEqualTypeOf<string>();
expectTypeOf<BrowserHostTab["notify"]>().toEqualTypeOf<
  (notice: string) => void
>();
expectTypeOf<BrowserHostTab["send"]>().returns.toEqualTypeOf<
  Promise<unknown>
>();

declare const tab: BrowserHostTab;

// A tab's events are typed as CdpConnection's are.
expectTypeOf(tab.on("Page.frameNavigated", () => {})).toEqualTypeOf<
  () => void
>();
tab.on("Page.frameNavigated", ({ params }) => {
  expectTypeOf(params.frame.url).toEqualTypeOf<string>();
  // @ts-expect-error not a field of Page.frameNavigated
  void params.frmae;
});
tab.on("Cloudflare.handoffComplete", ({ params }) => {
  expectTypeOf(params).toEqualTypeOf<Record<string, unknown>>();
});
expectTypeOf(tab.waitFor("Page.loadEventFired")).toEqualTypeOf<
  Promise<CdpEvent<"Page.loadEventFired">>
>();
void tab.waitFor("Page.frameNavigated", {
  predicate: ({ params }) => params.frame.parentId === undefined
});
// The tab's session id is bound: callers can't pass their own.
// @ts-expect-error sessionId is not a send option on a tab.
void tab.send("Page.enable", {}, { sessionId: "other" });
// @ts-expect-error sessionId is not a waitFor option on a tab.
void tab.waitFor("Page.loadEventFired", { sessionId: "other" });
