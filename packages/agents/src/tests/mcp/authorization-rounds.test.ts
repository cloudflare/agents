import { describe, expect, it } from "vitest";
import {
  completeRound,
  startRound
} from "../../mcp/client/authorization-rounds";

/** The rounds after asking for each `[scope, state]` in turn. */
function ask(links: Array<[scope: string, state: string]>) {
  let rounds: Parameters<typeof completeRound>[0];
  for (const [scope, state] of links) {
    const decision = startRound(rounds, scope, 0, state);
    if (decision._tag !== "start") throw new Error("expected a round");
    rounds = decision.rounds;
  }
  return rounds;
}

describe("completeRound", () => {
  it("completes the round of the link's own scope set", () => {
    const rounds = ask([
      ["write", "state-write"],
      ["admin", "state-admin"]
    ]);

    const after = completeRound(rounds, "state-write");

    expect(after?.byScope.write.completed).toBe(true);
    expect(after?.byScope.admin.completed).toBe(false);
  });

  it("completes nothing for a link it does not remember", () => {
    const rounds = ask([["admin", "state-admin"]]);

    const after = completeRound(rounds, "state-forgotten");

    expect(after?.byScope.admin.completed).toBe(false);
  });

  it("completes the latest round for rounds stored before links were recorded", () => {
    const legacy = {
      latest: "admin",
      byScope: { admin: { rounds: 1, completed: false, at: 0 } }
    };

    expect(completeRound(legacy, "any")?.byScope.admin.completed).toBe(true);
  });
});
