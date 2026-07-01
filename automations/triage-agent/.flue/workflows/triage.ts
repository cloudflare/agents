import { defineAgent, defineWorkflow } from "@flue/runtime";
import { local } from "@flue/runtime/node";
import * as v from "valibot";

/**
 * The triage agent.
 *
 * Runs automatically on every newly opened issue. It reads the issue and the
 * repo's existing labels, then applies the labels that fit. It can ONLY apply
 * labels that already exist (enforced by `gh issue edit --add-label`, which
 * refuses unknown labels) and must NOT comment on the issue or touch PRs.
 *
 * Runs in GitHub Actions. The `local()` sandbox gets only a scoped `GH_TOKEN`.
 */
const agent = defineAgent(() => ({
  model: "cloudflare-ai-gateway/claude-opus-4-8",
  sandbox: local({
    env: {
      GH_TOKEN: process.env.GH_TOKEN,
    },
  }),
}));

export default defineWorkflow({
  agent,
  input: v.object({
    issueNumber: v.number(),
    repo: v.optional(v.string()),
  }),

  async run({ harness, input }) {
    const session = await harness.session();

    const { data } = await session.skill("triage", {
      args: {
        issueNumber: input.issueNumber,
        repo: input.repo ?? "cloudflare/agents",
      },
      result: v.object({
        labelsApplied: v.array(v.string()),
        summary: v.string(),
      }),
    });

    return data;
  },
});
