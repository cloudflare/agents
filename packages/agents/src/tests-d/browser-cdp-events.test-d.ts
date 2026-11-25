import type { Protocol } from "devtools-protocol";
import { expectTypeOf } from "vitest";
import type { CdpConnection, CdpEvent, CdpEventHandler } from "../browser";

declare const cdp: CdpConnection;

// A protocol event's handler gets that event's params.
cdp.on("Page.frameNavigated", (event) => {
  expectTypeOf(event.method).toEqualTypeOf<"Page.frameNavigated">();
  expectTypeOf(event.params.frame).toEqualTypeOf<Protocol.Page.Frame>();
  expectTypeOf(event.params.type).toEqualTypeOf<Protocol.Page.NavigationType>();
  // @ts-expect-error not a field of Page.frameNavigated
  void event.params.frmae;
  // @ts-expect-error events are read-only: other handlers get the same one
  event.method = "Page.loadEventFired";
});

// An event the protocol sends without params gets `{}`.
cdp.on("Page.frameResized", (event) => {
  expectTypeOf(event.params).toEqualTypeOf<Record<string, never>>();
});

// Any other name is allowed, with untyped params.
cdp.on("Cloudflare.handoffComplete", (event) => {
  expectTypeOf(event.method).toEqualTypeOf<"Cloudflare.handoffComplete">();
  expectTypeOf(event.params).toEqualTypeOf<Record<string, unknown>>();
});

// So is a name only known at runtime: any event.
declare const method: string;
cdp.on(method, (event) => {
  expectTypeOf(event).toEqualTypeOf<CdpEvent>();
});

// A typed event is a plain CdpEvent, so a handler for any event fits
// every method.
expectTypeOf<CdpEvent<"Page.frameNavigated">>().toExtend<CdpEvent>();
const logEvent: CdpEventHandler = (event) => console.log(event.method);
cdp.on("Page.frameNavigated", logEvent);
cdp.on("Cloudflare.handoffComplete", logEvent, { sessionId: null });

// A handler for one event doesn't fit another.
const onLoad: CdpEventHandler<"Page.loadEventFired"> = () => {};
// @ts-expect-error a Page.loadEventFired handler for Page.frameNavigated
cdp.on("Page.frameNavigated", onLoad);

// waitFor's event and predicate are typed the same way.
expectTypeOf(cdp.waitFor("Page.loadEventFired")).toEqualTypeOf<
  Promise<CdpEvent<"Page.loadEventFired">>
>();
void cdp.waitFor("Page.frameNavigated", {
  sessionId: "session",
  predicate: ({ params }) => params.frame.parentId === undefined
});
void cdp.waitFor("Page.loadEventFired", {
  // @ts-expect-error Page.loadEventFired has no frame
  predicate: ({ params }) => params.frame !== undefined
});
expectTypeOf(cdp.waitFor(method)).toEqualTypeOf<Promise<CdpEvent>>();
