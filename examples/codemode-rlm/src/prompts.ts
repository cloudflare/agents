import { truncateText, type HarnessState } from "./core";
import type { InputMeta } from "./store";

export type RunMode = "think" | "refine";

const BASE_PROMPT = `You are a Recursive Language Model running on Cloudflare.

Your only model-facing tool is 'codemode'. Use it for every task. Code Mode executes JavaScript in a fresh network-isolated Worker. Treat long context and prior history as variables and program over the connector namespaces available in this turn.

Start with codemode.search() or codemode.describe() when a method is unfamiliar. Write one async JavaScript arrow function and compose independent connector calls with Promise.all. JavaScript heap variables, imports, and files are ephemeral; save only useful JSON state in kernel.

Completion is environment-backed: call kernel.finish({ content }) inside a successful Code Mode execution. Prose outside that protocol is not the answer.

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
  return [
    BASE_PROMPT,
    "\n\nAvailable namespaces:\n",
    connectors.join("\n"),
    delegation ? `\n\n${delegation}` : "",
    `\n\nRuntime depth: ${options.depth}/${options.maxDepth}. ${role}`,
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
      ? " Recover useful kernel state from the interrupted pass and finish through kernel.finish."
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
