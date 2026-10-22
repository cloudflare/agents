import { describe, expect, it } from "vitest";
import {
  AUTHORIZATION_ROUNDS_WINDOW_MS,
  authorizationExhaustedMessage,
  completeRound,
  MAX_AUTHORIZATION_ROUNDS,
  parseAuthorizationRounds,
  requestedScope,
  startRound,
  type AuthorizationRounds
} from "../../mcp/client/authorization-rounds";

const NOW = 1_000_000_000_000;

/** Start and complete rounds for one scope set until the limit stops it. */
function completedRounds(scope: string, count: number) {
  let rounds: AuthorizationRounds | undefined;
  for (let i = 0; i < count; i++) {
    const decision = startRound(rounds, scope, NOW + i);
    if (decision._tag !== "start") return decision;
    rounds = completeRound(decision.rounds);
  }
  return rounds;
}

describe("authorization rounds", () => {
  it("normalizes the requested scope set of an authorization URL", () => {
    expect(
      requestedScope("https://as.example/authorize?scope=b%20a%20b&state=x")
    ).toBe("a b");
    expect(requestedScope("https://as.example/authorize?state=x")).toBe("");
    expect(requestedScope("not a url")).toBe("");
  });

  it("allows the limit of completed rounds for one scope set, then stops", () => {
    const rounds = completedRounds("files:write", MAX_AUTHORIZATION_ROUNDS);
    expect(rounds).toMatchObject({ rounds: MAX_AUTHORIZATION_ROUNDS });
    expect(
      startRound(
        rounds as AuthorizationRounds,
        "files:write",
        NOW + MAX_AUTHORIZATION_ROUNDS
      )
    ).toEqual({
      _tag: "exhausted",
      rounds: MAX_AUTHORIZATION_ROUNDS,
      scope: "files:write"
    });
  });

  it("counts more links for a round still waiting on the user as that round", () => {
    const first = startRound(undefined, "s", NOW);
    if (first._tag !== "start") throw new Error("expected a round");
    const again = startRound(first.rounds, "s", NOW + 1);
    expect(again).toMatchObject({ _tag: "start", rounds: { rounds: 1 } });
  });

  it("starts over for a different scope set or after the window", () => {
    const rounds = completedRounds("s", MAX_AUTHORIZATION_ROUNDS);
    if (!rounds || "_tag" in rounds) throw new Error("expected rounds");
    expect(startRound(rounds, "other", NOW + 10)).toMatchObject({
      _tag: "start",
      rounds: { scope: "other", rounds: 1 }
    });
    expect(
      startRound(rounds, "s", rounds.at + AUTHORIZATION_ROUNDS_WINDOW_MS + 1)
    ).toMatchObject({ _tag: "start", rounds: { rounds: 1 } });
  });

  it("parses only well-formed records", () => {
    const record = { scope: "s", rounds: 2, completed: true, at: NOW };
    expect(parseAuthorizationRounds(record)).toEqual(record);
    expect(parseAuthorizationRounds({ scope: "s" })).toBeUndefined();
    expect(parseAuthorizationRounds("x")).toBeUndefined();
  });

  it("names the scope in the exhausted message when there is one", () => {
    expect(authorizationExhaustedMessage(3, "a b")).toContain(
      'for scope "a b" after 3 completed authorizations'
    );
    expect(authorizationExhaustedMessage(3, "")).not.toContain("scope");
  });
});
