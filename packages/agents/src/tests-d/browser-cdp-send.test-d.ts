import type { Protocol } from "devtools-protocol";
import { expectTypeOf } from "vitest";
import type {
  BrowserHostTab,
  CdpCommandParams,
  CdpCommandResult,
  CdpConnection
} from "../browser";

declare const cdp: CdpConnection;
declare const sessionId: string;

// A protocol command resolves with its typed result.
expectTypeOf(
  cdp.send("Target.createTarget", { url: "about:blank" })
).toEqualTypeOf<Promise<Protocol.Target.CreateTargetResponse>>();
expectTypeOf(
  cdp.send("Runtime.evaluate", { expression: "1" }, { sessionId })
).resolves.toEqualTypeOf<Protocol.Runtime.EvaluateResponse>();
expectTypeOf<CdpCommandResult<"Page.enable">>().toEqualTypeOf<void>();

// Params the protocol requires are required, with their required fields,
// and a misspelled one is caught.
// @ts-expect-error Runtime.evaluate needs params
void cdp.send("Runtime.evaluate");
// @ts-expect-error Runtime.evaluate needs an expression
void cdp.send("Runtime.evaluate", {});
// @ts-expect-error not a param of Runtime.evaluate
void cdp.send("Runtime.evaluate", { expresion: "1" });

// Optional params, and none, can be left out, or be {} to reach the
// options.
void cdp.send("Page.enable");
void cdp.send("Page.enable", {}, { sessionId });
void cdp.send("Runtime.enable", {}, { sessionId });
expectTypeOf<CdpCommandParams<"Runtime.enable">>().toEqualTypeOf<
  Record<string, never>
>();
// @ts-expect-error Runtime.enable takes no params
void cdp.send("Runtime.enable", { expression: "1" });

// Any other command takes any object and resolves with unknown.
expectTypeOf(cdp.send("Cloudflare.getLiveView", { anything: 1 })).toEqualTypeOf<
  Promise<unknown>
>();
// @ts-expect-error params are an object
void cdp.send("Cloudflare.getLiveView", "params");

// So does a name only known at runtime, including with a value typed with
// an interface.
declare const method: string;
declare const params: Record<string, unknown>;
interface CustomParams {
  depth: number;
}
declare const custom: CustomParams;
expectTypeOf(cdp.send(method, params, { sessionId })).toEqualTypeOf<
  Promise<unknown>
>();
void cdp.send(method, custom);

// A tab's send is typed the same, bound to the tab's session.
declare const tab: BrowserHostTab;
expectTypeOf(tab.send("Page.getFrameTree")).toEqualTypeOf<
  Promise<Protocol.Page.GetFrameTreeResponse>
>();
// @ts-expect-error Runtime.evaluate needs params
void tab.send("Runtime.evaluate");
// @ts-expect-error the tab's session is bound
void tab.send("Page.enable", {}, { sessionId });
