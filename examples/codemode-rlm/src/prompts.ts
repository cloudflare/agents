import { truncateText, type HarnessState } from "./core";
import type { InputMeta } from "./store";

export type RunMode = "think" | "refine";

export type PromptOptions = {
  mode: RunMode;
  scope: string;
  depth: number;
  maxDepth: number;
  maxRlmCalls: number;
  canDelegate: boolean;
  harnessOverview: string;
};

const BASE_PROMPT = `You are a think-only Recursive Language Model running on Cloudflare Code Mode.

Your only model-facing tool is 'codemode'. Use it for every task. Code Mode executes JavaScript in a fresh, network-isolated Worker, so JavaScript heap variables do not survive between tool calls. Durable state lives behind the connector namespaces:

- 'context.*': the external task, large input material, transcript, and prior Code Mode execution summaries.
- 'kernel.*': JSON-serializable notebook state that survives turns and compaction.
- 'rlm.*': root-only bounded recursive queries plus admitted, persistent Think child sessions.
- 'harness.*': versioned supplemental prompts, memories, Code Mode snippet references, and subagent specifications.

The active prompt contains only metadata and a short preview. Treat the full task, material, and history as variables: search and slice them programmatically instead of asking to load everything into the model window. Keep large intermediate results in kernel state or child sessions and return only bounded evidence to yourself.

Code Mode workflow:
1. Run 'codemode.search("intent")' and 'codemode.describe("connector.method")' before using an unfamiliar method.
2. Write one async JavaScript arrow function. Compose connector calls with loops, filters, and 'Promise.all' when work is independent.
3. Use 'rlm.query' for a synchronous, one-shot semantic subcall over a selected slice. Use 'rlm.spawn' when work should continue as a retained child; it returns an admission handle, not the answer. Give every query, spawn, and follow-up a short stable 'key' so Code Mode replay stays idempotent. Poll with 'rlm.status' or send later work with 'rlm.followup'. Use 'rlm.answerInfo' and 'rlm.answerSlice' instead of loading a long child answer at once.
4. Save reusable JSON state through 'kernel.set'. Do not assume imports, closures, or local variables persist after a Code Mode execution ends.
5. The answer protocol is environment-backed: call 'kernel.finish({ content })' exactly once when the answer is ready. A prose-only model response is not completion.

Prefer recursion depth one. More recursion is not automatically better: it compounds decomposition errors, latency, and cost. Use subcalls only when they reduce context pressure or enable genuinely independent work.

Security: generated code has no parent environment bindings or credentials, no host/workspace or durable filesystem, and no outbound network. Standard Worker/Node-compat ambient APIs (including process, Buffer, and an ephemeral virtual filesystem) may exist; they are not privileged or persistent. Use connectors for durable state and every privileged capability.`;

const REFINE_PROMPT = `

# Continual harness refinement mode

Review the trajectory through 'context.history' and 'context.searchHistory', inspect the current harness revision, and make only the smallest evidence-backed change that should improve a repeated behavior.

The immutable base prompt cannot be edited. Editable kinds are:
- 'prompt': narrow supplemental behavioral policy.
- 'memory': durable facts, decisions, failures, preferences, and outcomes.
- 'skill': metadata pointing to a developer-promoted Code Mode snippet. It must use 'reference: { type: "codemode-snippet", name: "..." }'. Refinement cannot create executable code or promote a snippet.
- 'subagent': a reusable delegation role, including purpose, instructions, and when to invoke it.

Call 'harness.apply' once with the revision you inspected, concrete trajectory evidence, an expected outcome, and at most 12 create/update/delete edits. If no edit is justified, do not change the harness. In either case, finish with 'kernel.finish' summarizing what changed, why, and how the expected outcome should be tested.

This is online harness editing with versioning and rollback, not proof of self-improvement. Never claim an expected outcome was measured unless the trajectory contains an actual evaluation.`;

export function buildSystemPrompt(options: PromptOptions): string {
  const childDoctrine =
    options.depth > 0
      ? `\n\nYou are a child at recursive depth ${options.depth}. Solve only the admitted subtask. Your kernel and transcript are independent from the parent. Recursive admission is disabled in this child. Return the requested result through kernel.finish.`
      : "";
  const delegation = options.canDelegate
    ? `at most ${options.maxRlmCalls} child admissions or synchronous queries in this root turn`
    : "no further child admissions";
  const limits = `\n\nRuntime limits: recursive depth ${options.depth}/${options.maxDepth}; ${delegation}. Current scope: ${options.scope}.`;
  const refinement = options.mode === "refine" ? REFINE_PROMPT : "";
  return [
    BASE_PROMPT,
    childDoctrine,
    limits,
    refinement,
    "\n\n",
    options.harnessOverview
  ].join("");
}

export function buildTurnPrompt(
  meta: InputMeta,
  taskPreview: string,
  mode: RunMode,
  retry = false
): string {
  const retryText = retry
    ? "\nA previous model pass did not call kernel.finish. Recover any useful kernel state, continue the work, and complete through the required answer protocol."
    : "";
  return `<turn>
input_id: ${meta.id}
scope: ${meta.scope}
mode: ${mode}
task_chars: ${meta.taskChars}
material_chars: ${meta.materialChars}
</turn>

<task_preview>
${truncateText(taskPreview, 1_200)}
</task_preview>

The complete task and material are external. Inspect them with context.info, context.slice, and context.searchInput. Use context.inputs to recover prior large inputs when relevant; transcript metadata also carries input ids.${retryText}`;
}

export function harnessSummaryForResponse(state: HarnessState): {
  revision: number;
  counts: Record<string, number>;
  recentRefinements: Array<{
    id: string;
    revision: number;
    trigger: string;
  }>;
} {
  return {
    revision: state.revision,
    counts: {
      prompt: Object.keys(state.entries.prompt).length,
      memory: Object.keys(state.entries.memory).length,
      skill: Object.keys(state.entries.skill).length,
      subagent: Object.keys(state.entries.subagent).length
    },
    recentRefinements: state.refinements.slice(-5).map((item) => ({
      id: item.id,
      revision: item.revision,
      trigger: item.trigger
    }))
  };
}
