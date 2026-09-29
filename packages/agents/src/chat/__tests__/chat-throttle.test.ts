import { describe, expect, it } from "vitest";
import {
  chatThrottleOptions,
  DEFAULT_CHAT_THROTTLE_MS,
  resolveChatThrottleMs
} from "../chat-throttle";

describe("resolveChatThrottleMs", () => {
  it("throttles by default, so chat is protected without any configuration", () => {
    expect(resolveChatThrottleMs({})).toBe(DEFAULT_CHAT_THROTTLE_MS);
  });

  it("prefers an explicit throttle", () => {
    expect(resolveChatThrottleMs({ throttle: 25 })).toBe(25);
  });

  it("accepts the deprecated experimental_throttle, which every example passes", () => {
    expect(resolveChatThrottleMs({ experimental_throttle: 250 })).toBe(250);
  });

  it("prefers the current name when both are passed", () => {
    expect(
      resolveChatThrottleMs({ experimental_throttle: 250, throttle: 25 })
    ).toBe(25);
  });

  it("turns throttling off for false", () => {
    expect(resolveChatThrottleMs({ throttle: false })).toBeUndefined();
  });

  it("treats 0 as opting out rather than as unset", () => {
    expect(resolveChatThrottleMs({ throttle: 0 })).toBe(0);
    expect(resolveChatThrottleMs({ experimental_throttle: 0 })).toBe(0);
  });
});

describe("chatThrottleOptions", () => {
  // @ai-sdk/react v3 reads `experimental_throttle`; v4 reads `throttle`. Both
  // majors are in our peer range, so both names have to carry the value.
  it("spells the throttle under both option names", () => {
    expect(chatThrottleOptions({})).toEqual({
      experimental_throttle: DEFAULT_CHAT_THROTTLE_MS,
      throttle: DEFAULT_CHAT_THROTTLE_MS
    });
    expect(chatThrottleOptions({ throttle: 0 })).toEqual({
      experimental_throttle: 0,
      throttle: 0
    });
  });

  // `false` is represented by omitting both numeric SDK options.
  it("omits both names when throttling is off", () => {
    expect(chatThrottleOptions({ throttle: false })).toEqual({});
  });
});
