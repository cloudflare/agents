import { describe, expect, it } from "vitest";
import { buildRunEnvelope, validateRunTarget } from "../src/run-context";

const target = {
  repo: "cloudflare/workers-oauth-provider",
  issueNumber: 209,
  instruction: "fix the registered token endpoint auth method",
  commentId: 4905306032,
  requestedBy: { login: "mattzcarey" }
};

describe("agent-think run context", () => {
  it("persists the immutable target and requester in the submitted envelope", () => {
    expect(buildRunEnvelope(target)).toContain(
      '"repository":"cloudflare/workers-oauth-provider"'
    );
    expect(buildRunEnvelope(target)).toContain('"issue":209');
    expect(buildRunEnvelope(target)).toContain('"requested-by":"@mattzcarey"');
  });

  it("rejects substituted targets and unsafe requester mentions", () => {
    expect(() => validateRunTarget({ ...target, repo: "other/repo" })).toThrow(
      "Invalid Cloudflare repository"
    );
    expect(() =>
      validateRunTarget({
        ...target,
        requestedBy: { login: "@mattzcarey please-run" }
      })
    ).toThrow("Invalid GitHub login");
    expect(() => validateRunTarget({ ...target, commentId: -1 })).toThrow(
      "Invalid comment id"
    );
  });
});
