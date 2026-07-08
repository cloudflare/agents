import { describe, expect, it } from "vitest";
import {
  buildRunEnvelope,
  buildRunTelemetry,
  repoDirectory,
  validateRunTarget
} from "../src/run-context";

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

  it("keeps identity on every inference and recovery continuation", () => {
    expect(buildRunTelemetry(target, "session-209", "ThinkAgent")).toEqual({
      metadata: {
        agentId: "session-209",
        agentName: "ThinkAgent",
        conversationId: "session-209",
        repository: "cloudflare/workers-oauth-provider",
        issueNumber: 209,
        requestedBy: "mattzcarey"
      }
    });
  });

  it("uses the repository name directly under /workspace", () => {
    expect(repoDirectory("cloudflare/agents")).toBe("/workspace/agents");
    expect(repoDirectory("owner/my repo")).toBe("/workspace/my-repo");
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
