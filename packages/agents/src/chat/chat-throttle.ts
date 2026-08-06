/**
 * How often chat state is allowed to re-render the UI.
 *
 * The AI SDK writes chat state once per streamed chunk, and each write is a
 * React render. Without a throttle a burst of chunks becomes a burst of
 * renders, and past 50 in an unbroken row React throws "Maximum update depth
 * exceeded" (#1913). A throttle collapses those renders no matter how many
 * chunks arrive, which is why it protects cases chunk merging cannot: a replay
 * of many tool steps, or any other backlog delivered in one go.
 *
 * Any value above zero prevents that crash, because the update then arrives
 * from a timer rather than from the current task. The size of the value is a
 * cost decision instead, measured over a 200-chunk turn at ~100 chunks/sec:
 *
 *   off  404 commits / 138ms   50ms  90 commits / 37ms
 *   16ms 261 commits /  89ms  100ms  48 commits / 21ms
 *
 * 50ms removes 78% of the renders. Going higher saves progressively less and
 * makes the text lag further behind the stream, so this sits at the knee of
 * that curve. It is also the value the AI SDK's own documentation uses.
 *
 * This does not delay the first chunk. The SDK throttles with `throttleit`,
 * which runs the first call of an idle window immediately, so only mid-stream
 * updates are coalesced.
 *
 * It is a mitigation rather than a guarantee. `useChat` throttles the store
 * subscription, but its `getSnapshot` returns a new messages array on every
 * chunk, and React forces a synchronous re-render whenever that identity moved
 * during a render — a path the throttle never sees (vercel/ai#6166, fix open in
 * vercel/ai#17893). Only writing state less often bounds it, which is why the
 * transport also merges replayed chunks before they reach the SDK.
 */
export const DEFAULT_CHAT_THROTTLE_MS = 50;

export type ChatThrottleOptions = {
  /**
   * Milliseconds to coalesce chat updates, or `false` to render every chunk.
   */
  throttle?: number | false;
  /** @deprecated Use `throttle`. */
  experimental_throttle?: number;
};

/** What gets forwarded to `useChat`. Omitted keys mean "do not throttle". */
type ForwardedThrottleOptions = {
  throttle?: number;
  experimental_throttle?: number;
};

/**
 * Picks the throttle from an explicit caller value, the deprecated alias, or
 * the default — in that order. `false` turns throttling off.
 */
export function resolveChatThrottleMs(
  options: ChatThrottleOptions
): number | undefined {
  if (options.throttle === false) return undefined;
  return (
    options.throttle ??
    options.experimental_throttle ??
    DEFAULT_CHAT_THROTTLE_MS
  );
}

/**
 * The throttle spelled under both option names, or neither name when it is off.
 *
 * The two names are not interchangeable across the peer range. `@ai-sdk/react`
 * v3 only reads `experimental_throttle`; v4 renamed it to `throttle` and reads
 * `throttle ?? experimental_throttle`. Our peer range allows both majors, so
 * sending one name would silently do nothing on the other. Unknown option keys
 * are ignored by both, so sending both names is safe.
 *
 * Turning throttling off omits both names rather than sending `0`. Both majors
 * decide with `waitMs != null`, so an omitted option is the only spelling that
 * takes the SDK's own unthrottled path; `0` still wraps the callback and only
 * behaves like "off" as a side effect of how the delay is computed.
 */
export function chatThrottleOptions(
  options: ChatThrottleOptions
): ForwardedThrottleOptions {
  const ms = resolveChatThrottleMs(options);
  if (ms === undefined) return {};
  return { experimental_throttle: ms, throttle: ms };
}
