import type { CodemodeSkill, CodemodeSkillSource } from "@cloudflare/codemode";

/**
 * Bundled skills — reusable code patterns that combine connector methods.
 * These appear in codemode.search results and can be run via codemode.run().
 */
const skills: CodemodeSkill[] = [
  {
    name: "list-open-prs",
    description: "List open pull requests for a repository.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string", description: "Repository owner" },
        repo: { type: "string", description: "Repository name" }
      },
      required: ["owner", "repo"]
    },
    code: `async ({ owner, repo }) => {
      return await github.list_pull_requests({ owner, repo, state: "open" });
    }`
  },
  {
    name: "repo-overview",
    description:
      "Get a combined overview of a repository: metadata and recent releases.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string" },
        repo: { type: "string" }
      },
      required: ["owner", "repo"]
    },
    code: `async ({ owner, repo }) => {
      const [metadata, releases] = await Promise.all([
        repoApi.request({ operationId: "get_repository", params: { owner, repo } }),
        repoApi.request({ operationId: "list_releases", params: { owner, repo } }),
      ]);
      return { metadata, releases };
    }`,
    instructions:
      "Combines repository metadata and release listing into a single overview. Uses both the github and repoApi connectors."
  }
];

export const bundledSkills: CodemodeSkillSource = {
  id: "bundled",
  async list() {
    return skills;
  },
  async load(name) {
    return skills.find((s) => s.name === name) ?? null;
  }
};
