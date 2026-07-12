# 18 — Channels: per-surface policy & out-of-band notices

Original: `think/channels/index.ts` + channel plumbing in think.ts. A channel
is a surface a turn arrives on (web WebSocket, messenger webhook, voice,
custom). Channels carry per-surface policy and out-of-band delivery. The
rebuild ports the registry, policy application, and `deliverNotice`; messenger
ingress itself stays behind a `Messenger` port.

## Definitions

```ts
export type ChannelKind = "web" | "messenger" | "voice" | "custom";
export interface ChannelContext { channelId: string; kind: ChannelKind; thread?: string }
export interface ChannelDefinition {
  kind: ChannelKind;
  instructions?: string | ((ctx: ChannelContext) => string | Promise<string>);
  tools?: (all: ToolSet) => ToolSet;            // filter only — may not add
  maxTurns?: number;                            // step cap for turns on this channel
  capabilities?: { streaming?: boolean; editing?: boolean };
  deliver?: ChannelDelivery;                    // messenger/custom outbound
}
export interface ChannelDelivery {
  /** Deliver text out-of-band. thread required for multi-thread surfaces. */
  post(text: string, opts: { kind: "final" | "interim" | "notice" | "command"; thread?: string }): Promise<void>;
}
```

## Behaviors to preserve

1. **Implicit `web` channel** always exists (kind web, streaming
   capabilities). `configureChannels()` may override its policy but cannot
   remove it. Channel-id collisions between declared channels and messenger
   ids → ValidationError at registration.
2. **Policy application order** (turn assembly, doc 23): channel policy is an
   *overridable default* applied before `beforeTurn` — `beforeTurn`'s returns
   win. Specifically:
   - `instructions` (resolved, possibly async) prepended to the base system
     prompt;
   - `tools` filter applied to the assembled ToolSet (a filter that
     introduces a tool name not present in the input is an error);
   - maxSteps precedence: `beforeTurn.maxSteps` > channel `maxTurns` >
     instance default.
3. **Channel stamping**: the channel id is stamped on the inbound user
   message's `metadata.channelId`, so a recovered/continued turn re-resolves
   the same channel and re-applies policy.
4. `activeChannel`: the ChannelContext for the in-flight turn, else undefined.
   A turn with no channel applies no policy.
5. **`deliverNotice(text, opts)`** — no model turn, no turn queue, safe from
   inside tool execute:
   - target = `opts.channel` ?? active turn's channel ?? `"web"`;
   - `web`: append a notice to the transcript (assistant message with
     `metadata.notice: true`; `informModel` only shapes phrasing) + broadcast;
   - channels with `deliver`: post to the surface; `informModel: true`
     additionally writes it to the transcript; out-of-turn multi-thread
     delivery without `thread` → throw;
   - `voice` / `custom` without `deliver`: out-of-turn delivery throws.
   - Events: `notice:delivered` / `notice:failed`.
6. **`renderAttachment(attachment) → string | undefined`** hook: at end of
   turn, each reply attachment (doc 12) is rendered and delivered as a
   trailing `interim` notice; undefined skips.
7. Events: `channel:resolved` (turn resolved a registered channel),
   `channel:delivered` (final reply delivered to a non-web channel).

## Proposed interface

```ts
export interface ChannelService {
  register(channels: Record<string, ChannelDefinition>): void;   // validates; merges over implicit web
  resolve(channelId: string | undefined): ChannelContext | undefined;
  policyFor(channelId: string | undefined): Promise<{
    instructions?: string; toolFilter?: (t: ToolSet) => ToolSet; maxTurns?: number }>;
  active(): ChannelContext | undefined;
  runWithActive<T>(ctx: ChannelContext | undefined, fn: () => Promise<T>): Promise<T>;
  deliverNotice(text: string, opts?: { channel?: string; informModel?: boolean;
    kind?: "final" | "interim" | "notice" | "command"; thread?: string }): Promise<void>;
}
export function createChannelService(deps: {
  bus: EventBus;
  transcriptNotice: (text: string, informModel: boolean) => Promise<void>;  // Think wires this
}): ChannelService;
```

## Tests
- implicit web present; collision validation; policy precedence (beforeTurn >
  channel > default) — tested at Think level but the precedence resolver is
  pure here; tools filter cannot add; instructions resolver (async fn form);
  deliverNotice routing matrix (web / delivering channel / voice throw /
  missing thread throw); notice events; active-channel scoping via
  runWithActive.
