import { describe, expect, it } from "vitest";
import { relayedConnectionState } from "../../dynamic-agents/dynamic-agents";

const tags = { _cf_subAgentTags: ["t"] };
const following = { ...tags, _cf_logs: ["feed"] };

describe("the socket state a facet keeps when a relayed message arrives", () => {
  it("takes a nested follower's subscription from the root while its own state write is in flight (F18)", () => {
    // The outer facet's own full-state write is on its way to the root; the
    // inner facet's subscription already landed there.
    expect(
      relayedConnectionState(tags, following, {
        stateWritePending: true,
        flagWritePending: false
      })
    ).toEqual(following);
  });

  it("keeps its own subscription while that flag write is in flight", () => {
    expect(
      relayedConnectionState(following, tags, {
        stateWritePending: false,
        flagWritePending: true
      })
    ).toEqual(following);
  });

  it("keeps its own unsubscribe while that flag write is in flight", () => {
    expect(
      relayedConnectionState(tags, following, {
        stateWritePending: false,
        flagWritePending: true
      })
    ).toEqual(tags);
  });

  it("keeps its own state but the root's flag while only a state write is in flight", () => {
    expect(
      relayedConnectionState(
        { ...tags, mine: 1 },
        { ...following, mine: 0 },
        {
          stateWritePending: true,
          flagWritePending: false
        }
      )
    ).toEqual({ ...following, mine: 1 });
  });

  it("takes the root's copy when nothing is in flight", () => {
    expect(
      relayedConnectionState(following, tags, {
        stateWritePending: false,
        flagWritePending: false
      })
    ).toEqual(tags);
  });
});
