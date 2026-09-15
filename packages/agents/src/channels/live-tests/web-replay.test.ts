import { expect, test } from "vitest";
import { webBinding } from "./bindings/web";
import { withDestination } from "./helpers";

test("replays a disconnected Web response and follows its live tail", async () => {
  await withDestination(webBinding, async (channel) => {
    await expect(channel.durableReplayRoundTrip()).resolves.toEqual({
      text: "Durable prefix and live tail",
      textDeltas: 2
    });
  });
});

test("replays partial output and a durable producer error", async () => {
  await withDestination(webBinding, async (channel) => {
    await expect(channel.durableErroredReplayRoundTrip()).resolves.toEqual({
      text: "Durable partial answer",
      error: "durable generation failed"
    });
  });
});

test("replays a browser tool only to its replacement owner", async () => {
  await withDestination(webBinding, async (channel) => {
    await expect(channel.durableClientToolReplayRoundTrip()).resolves.toEqual({
      replayedToolCalls: 1,
      routedToolResults: 1,
      memberToolCalls: 0
    });
  });
});
