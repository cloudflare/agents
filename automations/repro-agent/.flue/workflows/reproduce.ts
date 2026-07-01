import { defineAgent, defineWorkflow } from "@flue/runtime";
import { local } from "@flue/runtime/node";
import * as v from "valibot";

/**
 * The reproduction agent.
 *
 * Runs in GitHub Actions against the checked-out `cloudflare/agents` repo. The
 * `local()` sandbox executes the agent's bash tool directly against the runner
 * shell, so `gh`, `git`, `npm`, and `wrangler` are all reachable on `$PATH`.
 *
 * Host env vars are opt-in. We forward only `GH_TOKEN` so the agent can read
 * the issue and post a comment back. We deliberately DO NOT forward any
 * Cloudflare credentials into the sandbox: `wrangler deploy --temporary`
 * requires an unauthenticated Wrangler, and errors if `CLOUDFLARE_API_TOKEN`
 * or OAuth is present. The Flue/Pi harness still uses the AI Gateway creds
 * from the parent process for inference — those never reach the agent shell.
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
    // Free-form text the user typed after `/repro`, e.g. extra repro steps or
    // a pointer to the suspect area. May be empty.
    context: v.optional(v.string()),
  }),

  async run({ harness, input }) {
    const session = await harness.session();

    const { data } = await session.skill("reproduce", {
      args: {
        issueNumber: input.issueNumber,
        repo: input.repo ?? "cloudflare/agents",
        context: input.context ?? "",
      },
      result: v.object({
        reproduced: v.boolean(),
        skipped: v.boolean(),
        summary: v.string(),
        liveUrl: v.optional(v.string()),
        claimUrl: v.optional(v.string()),
        rootCauseHypothesis: v.optional(v.string()),
        commentUrl: v.optional(v.string()),
      }),
    });

    return data;
  },
});
