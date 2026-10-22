import { describe, expect, it } from "vitest";
import {
  AUTHORIZATION_ROUNDS_WINDOW_MS,
  authorizationExhaustedMessage,
  completeRound,
  MAX_AUTHORIZATION_ROUNDS,
  parseAuthorizationRounds,
  requestedScope,
  startRound,
  type AuthorizationRounds,
  type RoundDecision
} from "../../mcp/client/authorization-rounds";

const NOW = 1_000_000_000_000;

/** Start a round for `scope` and, when shown, complete it. */
function round(
  rounds: AuthorizationRounds | undefined,
  scope: string,
  at: number
): { decision: RoundDecision; rounds: AuthorizationRounds | undefined } {
  const decision = startRound(rounds, scope, at);
  return {
    decision,
    rounds: decision._tag === "start" ? completeRound(decision.rounds) : rounds
  };
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
    let rounds: AuthorizationRounds | undefined;
    for (let i = 0; i < MAX_AUTHORIZATION_ROUNDS; i++) {
      const next = round(rounds, "files:write", NOW + i);
      expect(next.decision._tag).toBe("start");
      rounds = next.rounds;
    }
    expect(startRound(rounds, "files:write", NOW + 10)).toEqual({
      _tag: "exhausted",
      rounds: MAX_AUTHORIZATION_ROUNDS,
      scope: "files:write"
    });
  });

  it("keeps each scope set's budget when challenges alternate", () => {
    let rounds: AuthorizationRounds | undefined;
    let at = NOW;
    for (let i = 0; i < MAX_AUTHORIZATION_ROUNDS; i++) {
      for (const scope of ["deploy:write", "billing:write"]) {
        const next = round(rounds, scope, at++);
        expect(next.decision._tag).toBe("start");
        rounds = next.rounds;
      }
    }
    expect(startRound(rounds, "deploy:write", at)).toMatchObject({
      _tag: "exhausted",
      scope: "deploy:write"
    });
    expect(startRound(rounds, "billing:write", at)).toMatchObject({
      _tag: "exhausted",
      scope: "billing:write"
    });
  });

  it("counts more links for a round still waiting on the user as that round", () => {
    const first = startRound(undefined, "s", NOW);
    if (first._tag !== "start") throw new Error("expected a round");
    expect(startRound(first.rounds, "s", NOW + 1)).toMatchObject({
      _tag: "start",
      rounds: { byScope: { s: { rounds: 1, completed: false } } }
    });
  });

  it("forgets a scope set's rounds after the window", () => {
    let rounds: AuthorizationRounds | undefined;
    for (let i = 0; i < MAX_AUTHORIZATION_ROUNDS; i++) {
      rounds = round(rounds, "s", NOW + i).rounds;
    }
    expect(
      startRound(
        rounds,
        "s",
        NOW + MAX_AUTHORIZATION_ROUNDS + AUTHORIZATION_ROUNDS_WINDOW_MS
      )
    ).toMatchObject({
      _tag: "start",
      rounds: { byScope: { s: { rounds: 1 } } }
    });
  });

  it("counts scope sets named like Object members", () => {
    for (const scope of ["constructor", "toString", "__proto__"]) {
      let rounds: AuthorizationRounds | undefined;
      for (let i = 0; i < MAX_AUTHORIZATION_ROUNDS; i++) {
        const next = round(rounds, scope, NOW + i);
        expect(next.decision._tag).toBe("start");
        // Round-trip through storage like the manager does.
        rounds = parseAuthorizationRounds(
          JSON.parse(JSON.stringify(next.rounds))
        );
      }
      expect(startRound(rounds, scope, NOW + 10)).toMatchObject({
        _tag: "exhausted",
        scope
      });
    }
  });

  it("parses only well-formed records", () => {
    const record = {
      latest: "s",
      byScope: { s: { rounds: 2, completed: true, at: NOW } }
    };
    expect(parseAuthorizationRounds(record)).toEqual(record);
    expect(
      parseAuthorizationRounds({ latest: "s", byScope: { s: { rounds: 1 } } })
    ).toEqual({ latest: "s", byScope: {} });
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
