const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const CLOUDFLARE_REPO = /^cloudflare\/[A-Za-z0-9_.-]+$/;

export interface RequestedBy {
  login: string;
  avatarUrl?: string;
}

export interface RunTarget {
  repo: string;
  issueNumber: number;
  instruction: string;
  commentId?: number;
  issueTitle?: string;
  requestedBy?: RequestedBy;
}

export function repoDirectory(repo: string | undefined): string {
  const name = repo?.split("/").filter(Boolean).at(-1) ?? "repo";
  const safe = name.replace(/[^a-zA-Z0-9._-]+/g, "-") || "repo";
  return `/workspace/${safe}`;
}

export function validateRunTarget(target: RunTarget): RunTarget {
  if (
    !CLOUDFLARE_REPO.test(target.repo) ||
    target.repo.endsWith("/.") ||
    target.repo.endsWith("/..")
  ) {
    throw new Error(`Invalid Cloudflare repository: ${target.repo}`);
  }
  if (!Number.isSafeInteger(target.issueNumber) || target.issueNumber <= 0) {
    throw new Error(`Invalid issue number: ${target.issueNumber}`);
  }
  if (
    target.commentId !== undefined &&
    (!Number.isSafeInteger(target.commentId) || target.commentId <= 0)
  ) {
    throw new Error(`Invalid comment id: ${target.commentId}`);
  }
  if (target.requestedBy && !GITHUB_LOGIN.test(target.requestedBy.login)) {
    throw new Error(`Invalid GitHub login: ${target.requestedBy.login}`);
  }
  return target;
}

/** Stable trace identity applied to every inference, including recovery. */
export function buildRunTelemetry(
  target: RunTarget,
  agentId: string,
  agentName: string
) {
  validateRunTarget(target);
  return {
    metadata: {
      agentId,
      agentName,
      conversationId: agentId,
      repository: target.repo,
      issueNumber: target.issueNumber,
      ...(target.requestedBy ? { requestedBy: target.requestedBy.login } : {})
    }
  };
}

/**
 * Durable, model-visible run identity. This deliberately duplicates the
 * read-only Session context: the submitted user message is persisted with the
 * turn and survives every continuation.
 */
export function buildRunEnvelope(target: RunTarget): string {
  validateRunTarget(target);
  const envelope = {
    repository: target.repo,
    issue: target.issueNumber,
    ...(target.issueTitle ? { "issue-title": target.issueTitle } : {}),
    instruction: target.instruction || "reproduce this issue",
    "requested-by": target.requestedBy
      ? `@${target.requestedBy.login}`
      : "unknown",
    ...(target.commentId !== undefined
      ? { "trigger-comment-id": target.commentId }
      : {})
  };
  return [
    "<agent-think-run>",
    JSON.stringify(envelope),
    "</agent-think-run>",
    "Use exactly this repository and issue. Never infer or substitute another target.",
    "Activate the matching skill, follow it end to end, and return its structured result."
  ].join("\n");
}
