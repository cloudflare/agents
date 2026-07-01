import { defineTool } from "@flue/runtime";
import * as v from "valibot";

/**
 * Typed GitHub tools for the triage agent.
 *
 * Trusted application code (these functions) owns the token, repo, and issue
 * number — all read from `process.env` set by the workflow. The model only
 * chooses which existing labels to apply. It never sees the token and has no
 * generic HTTP/shell escape hatch.
 *
 * Capabilities are intentionally minimal:
 *   - read the current issue,
 *   - list the repo's existing labels,
 *   - add existing labels to the issue.
 * There is no comment, no label creation, no cross-issue access, no delete.
 */

function ghEnv() {
  const token = process.env.GH_TOKEN;
  const repo = process.env.REPO;
  const issueNumber = Number(process.env.ISSUE_NUMBER);
  if (!token) throw new Error("GH_TOKEN is not set");
  if (!repo || !repo.includes("/"))
    throw new Error("REPO is not set to owner/repo");
  if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
    throw new Error("ISSUE_NUMBER is not a positive integer");
  }
  const [owner, name] = repo.split("/", 2);
  return { token, owner, name, issueNumber };
}

function ghHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "triage-agent"
  };
}

async function ghFetch(
  token: string,
  path: string,
  init?: RequestInit
): Promise<Response> {
  const res = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: { ...ghHeaders(token), ...(init?.headers ?? {}) }
  });
  return res;
}

export const viewIssue = defineTool({
  name: "view_issue",
  description:
    "Read the issue currently being triaged (title, body, author, current labels). Takes no arguments; the issue is fixed by the workflow.",
  output: v.object({
    number: v.number(),
    title: v.string(),
    body: v.string(),
    author: v.string(),
    currentLabels: v.array(v.string())
  }),
  async run({ signal }) {
    const { token, owner, name, issueNumber } = ghEnv();
    const res = await ghFetch(
      token,
      `/repos/${owner}/${name}/issues/${issueNumber}`,
      {
        signal
      }
    );
    if (!res.ok)
      throw new Error(`view_issue failed: ${res.status} ${await res.text()}`);
    const data = (await res.json()) as {
      number: number;
      title: string | null;
      body: string | null;
      user: { login: string } | null;
      labels: Array<{ name: string } | string>;
    };
    return {
      number: data.number,
      title: data.title ?? "",
      body: data.body ?? "",
      author: data.user?.login ?? "",
      currentLabels: data.labels.map((l) =>
        typeof l === "string" ? l : l.name
      )
    };
  }
});

export const listLabels = defineTool({
  name: "list_labels",
  description:
    "List the labels that already exist in the repository. These are the ONLY labels you may apply. Takes no arguments.",
  output: v.object({
    labels: v.array(v.object({ name: v.string(), description: v.string() }))
  }),
  async run({ signal }) {
    const { token, owner, name } = ghEnv();
    const res = await ghFetch(
      token,
      `/repos/${owner}/${name}/labels?per_page=100`,
      {
        signal
      }
    );
    if (!res.ok)
      throw new Error(`list_labels failed: ${res.status} ${await res.text()}`);
    const data = (await res.json()) as Array<{
      name: string;
      description: string | null;
    }>;
    return {
      labels: data.map((l) => ({
        name: l.name,
        description: l.description ?? ""
      }))
    };
  }
});

export const applyLabels = defineTool({
  name: "apply_labels",
  description:
    "Add one or more EXISTING labels to the issue being triaged. Labels that do not already exist in the repo are rejected (this tool never creates labels). Pass an empty array to apply nothing.",
  input: v.object({
    labels: v.array(v.string())
  }),
  output: v.object({
    applied: v.array(v.string()),
    rejected: v.array(v.string())
  }),
  async run({ input, signal }) {
    const { token, owner, name, issueNumber } = ghEnv();
    if (input.labels.length === 0) return { applied: [], rejected: [] };

    // Validate against existing labels — never create new ones.
    const labelsRes = await ghFetch(
      token,
      `/repos/${owner}/${name}/labels?per_page=100`,
      {
        signal
      }
    );
    if (!labelsRes.ok) {
      throw new Error(
        `apply_labels (list) failed: ${labelsRes.status} ${await labelsRes.text()}`
      );
    }
    const existing = new Set(
      ((await labelsRes.json()) as Array<{ name: string }>).map((l) => l.name)
    );
    const toApply = input.labels.filter((l) => existing.has(l));
    const rejected = input.labels.filter((l) => !existing.has(l));
    if (toApply.length === 0) return { applied: [], rejected };

    const res = await ghFetch(
      token,
      `/repos/${owner}/${name}/issues/${issueNumber}/labels`,
      {
        method: "POST",
        body: JSON.stringify({ labels: toApply }),
        signal
      }
    );
    if (!res.ok)
      throw new Error(`apply_labels failed: ${res.status} ${await res.text()}`);
    return { applied: toApply, rejected };
  }
});
