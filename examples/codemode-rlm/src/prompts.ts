import { truncateText, type HarnessState } from "./core";
import type { InputMeta } from "./store";

export type RunMode = "think" | "refine";

const BASE_PROMPT = `You are a Recursive Language Model running on Cloudflare.

Your only model-facing tool is 'codemode'. Use it for every task. Code Mode executes JavaScript in a fresh network-isolated Worker. Treat long context and prior history as variables and program over the connector namespaces available in this turn.

Start with codemode.search() or codemode.describe() when a method is unfamiliar. Write one no-argument async JavaScript arrow function and compose independent connector calls with Promise.all. Connector namespaces are globals such as context and kernel; never expect a ctx parameter. JavaScript heap variables and imports are ephemeral. Save compact JSON values in kernel and large or reusable artifacts as files under the durable Computer /workspace.

Connector methods take one object argument. Common calls are context.info({}), context.slice({ source: "material", start: 0, length: 8192 }), kernel.set({ key: "name", value }), workspace.write({ path: "/workspace/notes.json", content: "..." }), workspace.edit({ path: "/workspace/notes.json", edits: [{ oldText: "before", newText: "after" }] }), and kernel.finish({ content }).

Result shapes matter:
- workspace.read({ path }) returns an object whose content field contains the file text. For JSON files, parse read.content and then access the written value or fields such as .value.
- kernel.get({ key }) returns the stored JSON value directly, not a { value } wrapper.

Inspect schemas before guessing other signatures.

Completion is environment-backed: call kernel.finish({ content }) inside a successful Code Mode execution. Prose outside that protocol is not the answer.

Before finishing, verify that content directly satisfies the user's requested answer and format. Never finish with connector metadata, inspection output, or a work-in-progress value.

Generated code receives no parent credentials, environment bindings, host filesystem, browser/MCP tools, or outbound network. Privileged and durable effects cross connectors.`;

const REFINE_PROMPT = `

# Explicit harness refinement

Inspect recent context.history and harness.read. Change the supplemental harness only when concrete trajectory evidence supports a small improvement. The immutable base prompt cannot be edited.

Entries have one of three kinds:
- instruction: a narrow behavioral rule;
- memory: a durable fact, decision, failure, or preference;
- delegate: guidance for when and how to use a retained child.

Make at most one mutation in this refinement turn. Call harness.update with the revision you inspected, a reason, evidence, and at most 12 upserts/removals. Use harness.rollback with that expected revision only to restore a known earlier snapshot. Finish by reporting what changed and how it should be evaluated. A hypothesis is not measured self-improvement.`;

export function buildSystemPrompt(options: {
  mode: RunMode;
  depth: number;
  maxDepth: number;
  maxSteps: number;
  maxRlmCalls: number;
  canDelegate: boolean;
  canUseHarness: boolean;
  harnessOverview: string;
}): string {
  const role =
    options.depth > 0
      ? `You are a child at depth ${options.depth}; solve only the admitted subtask. Further recursion is disabled.`
      : options.canDelegate
        ? `You may create at most ${options.maxRlmCalls} recursive operations in this turn.`
        : "Recursive operations are disabled.";
  const connectors = [
    "- context: inspect, search, and slice external task material without loading it all into the model window.",
    "- kernel: save JSON notebook state across Code Mode calls and finish the current answer.",
    "- workspace: read, list, write, and edit durable per-agent files under /workspace.",
    ...(options.canDelegate
      ? [
          "- rlm: run one-shot semantic queries or admit work to retained depth-one Think agents."
        ]
      : []),
    ...(options.canUseHarness
      ? [
          "- harness: read supplemental instructions, memories, and delegation hints."
        ]
      : [])
  ];
  const delegation = options.canDelegate
    ? "Every rlm.query, rlm.spawn, and rlm.followup needs a short stable key. Query waits for a result. Spawn and followup return durable admission state; inspect them with rlm.status/list/read. Use children only when decomposition meaningfully reduces context pressure."
    : "";
  const nonTerminalSteps = Math.max(0, options.maxSteps - 1);
  const stepBudget = `You have at most ${options.maxSteps} model steps in this turn. Use no more than ${nonTerminalSteps} steps for inspection, programming, delegation, or harness work. Reserve one final model step for a Code Mode execution that calls kernel.finish with the best schema-valid answer you can produce. On that reserved step, do not inspect more context or perform work that can prevent kernel.finish from succeeding. Uncertainty or incomplete analysis is not a reason to omit kernel.finish.`;
  return [
    BASE_PROMPT,
    "\n\nAvailable namespaces:\n",
    connectors.join("\n"),
    delegation ? `\n\n${delegation}` : "",
    `\n\nRuntime depth: ${options.depth}/${options.maxDepth}. ${role}`,
    `\n\n# Step budget and mandatory finalization\n\n${stepBudget}`,
    options.mode === "refine" ? REFINE_PROMPT : "",
    options.harnessOverview ? `\n\n${options.harnessOverview}` : ""
  ].join("");
}

export function buildTurnPrompt(
  meta: InputMeta,
  taskPreview: string,
  mode: RunMode,
  retry = false
): string {
  return `<turn>
input_id: ${meta.id}
mode: ${mode}
task_chars: ${meta.taskChars}
material_chars: ${meta.materialChars}
</turn>

<task_preview>
${truncateText(taskPreview, 1_200)}
</task_preview>

The complete task and material are external. Use context.info, context.slice, context.search, and context.inputs to inspect them.${
    retry
      ? " Recover useful kernel state from the prior pass and finish through kernel.finish."
      : ""
  }`;
}

export function harnessSummary(state: HarnessState): {
  revision: number;
  entries: number;
  counts: Record<string, number>;
  lastChange?: HarnessState["lastChange"];
} {
  return {
    revision: state.revision,
    entries: state.entries.length,
    counts: Object.fromEntries(
      ["instruction", "memory", "delegate"].map((kind) => [
        kind,
        state.entries.filter((entry) => entry.kind === kind).length
      ])
    ),
    lastChange: state.lastChange
  };
}
