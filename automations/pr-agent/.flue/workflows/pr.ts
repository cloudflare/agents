import { defineAgent, defineWorkflow } from "@flue/runtime";
import { local } from "@flue/runtime/node";
import * as v from "valibot";

/**
 * The PR agent.
 *
 * Triggered by `/pr` on a GitHub issue. Takes all the info on the issue —
 * including any reproduction the repro-agent (`/repro`) already posted — and
 * attempts to one-shot a fix PR against `cloudflare/agents`.
 *
 * Runs in GitHub Actions on a checkout of the repo. The `local()` sandbox runs
 * the agent's bash tool against the runner shell, so `gh`, `git`, `npm`, and
 * `wrangler` are reachable. We forward `GH_TOKEN` so the agent can read the
 * issue/comments, push a branch, and open the PR. No Cloudflare deploy creds
 * are forwarded — this agent edits and tests code, it does not deploy.
 */
const agent = defineAgent(() => ({
  model: "cloudflare-ai-gateway/claude-opus-4-8",
  sandbox: local({
    env: {
      GH_TOKEN: process.env.GH_TOKEN
    }
  })
}));

export default defineWorkflow({
  agent,
  input: v.object({
    issueNumber: v.number(),
    repo: v.optional(v.string()),
    // The GitHub user who triggered `/pr`. Used to attribute the commit to
    // them via their github.com noreply email so the PR shows as authored by
    // that person rather than a bot.
    actorLogin: v.optional(v.string()),
    actorId: v.optional(v.number()),
    // Free-form text the user typed after `/pr`, e.g. constraints on the fix
    // or a pointer to the suspect area. May be empty.
    context: v.optional(v.string())
  }),

  async run({ harness, input }) {
    const session = await harness.session();

    const { data } = await session.skill("open-pr", {
      args: {
        issueNumber: input.issueNumber,
        repo: input.repo ?? "cloudflare/agents",
        actorLogin: input.actorLogin ?? "",
        actorId: input.actorId ?? 0,
        context: input.context ?? ""
      },
      result: v.object({
        prOpened: v.boolean(),
        skipped: v.boolean(),
        summary: v.string(),
        prUrl: v.optional(v.string()),
        branch: v.optional(v.string()),
        testsPassed: v.optional(v.boolean())
      })
    });

    return data;
  }
});
