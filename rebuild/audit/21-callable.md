# 21 — Callable registry: RPC over connections

Original: the `@callable` decorator + `getCallableMethods()` + the WebSocket
RPC protocol (`{ type: "rpc", id, method, args }` → one or more
`{ type: "rpc", id, success, result?, done?, error? }` responses), with
optional streaming via `@callable({ stream: true })` and emitted `rpc` /
`rpc:error` events.

## Behaviors to preserve

1. Registration: methods are opt-in. Rebuild offers both the decorator form
   (`@callable({ description?, stream? })` on app-class methods) and explicit
   registration (`registry.register(name, fn, opts)`), since decorators are a
   composition-layer nicety. Metadata: `{ description?, streaming? }`,
   exposed via `callableMethods(): Map<string, CallableMetadata>`.
2. Dispatch: given a parsed request `{ id, method, args }` and a responder:
   - unknown/unregistered method → error response ("not callable");
   - non-streaming: await result → `{ id, success: true, result, done: true }`;
   - streaming: the method receives a `StreamingResponse` handle as its first
     argument (original passes it before args? — original signature:
     streaming methods get `(stream, ...args)`) with `send(chunk)` →
     `{ id, success: true, result: chunk, done: false }` and `end(final?)` →
     `{ ..., done: true }`; method throw after partial sends still ends with
     an error frame;
   - thrown error → `{ id, success: false, error: message }` + `rpc:error`
     event; success emits `rpc` `{ method, streaming? }`.
3. Readonly connections may still call callables (state mutation policy is the
   method's concern); the app layer decides exposure.
4. Errors must never take down the connection loop.

## Proposed interface

```ts
export interface CallableMetadata { description?: string; streaming?: boolean }
export interface StreamingResponse { send(chunk: unknown): void; end(final?: unknown): void }
export interface RpcRequest { id: string; method: string; args: unknown[] }
export type RpcResponse =
  | { type: "rpc"; id: string; success: true; result: unknown; done: boolean }
  | { type: "rpc"; id: string; success: false; error: string; done: true };

export interface CallableRegistry {
  register(name: string, fn: (...args: unknown[]) => unknown, opts?: CallableMetadata & { streaming?: boolean }): void;
  callableMethods(): Map<string, CallableMetadata>;
  dispatch(request: RpcRequest, respond: (r: RpcResponse) => void): Promise<void>;
}
export function createCallableRegistry(deps: { bus: EventBus }): CallableRegistry;

/** Decorator for the app layer (stage-3 TC39 decorators, matching tsconfig). */
export function callable(opts?: CallableMetadata): (method: any, ctx: ClassMethodDecoratorContext) => void;
```
Decorator note: implement by tagging the method (a WeakMap or symbol property
keyed by class prototype + method name); the app layer's constructor scans and
registers tagged methods bound to the instance.

## Tests
- register/dispatch happy path; unknown method error frame; thrown error frame
  + event; streaming send/end framing incl. throw-after-send; metadata map;
  decorator tagging picked up by a scan helper.
