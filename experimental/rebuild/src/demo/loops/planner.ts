/**
 * DEMO MODULE — AgentLoop, the practical one.
 *
 * Plan-and-execute. The plan is a durable pass-through entry
 * ("planner/plan"), so a cold reader — or the next wake after a crash — sees
 * exactly which steps exist and how many are done. Progress updates are new
 * plan entries (append-only; latest wins), and intermediate step outcomes
 * land as "planner/note" entries rather than chat messages, keeping the
 * user-visible conversation clean while the log stays complete.
 *
 * This entire strategy — the thing that used to be interleaved through a
 * 900-line inference method — is one file that plugs into the same
 * stepHarness as every other loop, inheriting markers, retries, parking and
 * recovery.
 */

import type {
  AgentLoop,
  MessagePayload,
  NewEntry,
  Part,
  StepDeps,
  Versioned
} from "../../contract.js";
import { executeCalls } from "../../harness/default-loop.js";

export interface PlanPayload extends Versioned {
  readonly kind: "planner/plan";
  readonly v: 1;
  readonly steps: readonly string[];
  readonly done: number;
}

export interface PlanNotePayload extends Versioned {
  readonly kind: "planner/note";
  readonly v: 1;
  readonly step: number;
  readonly note: string;
}

export function planner(): AgentLoop {
  return {
    async step(deps) {
      const plan = await latestPlan(deps);

      // Phase 1 — no plan yet: ask the model to write one, commit it.
      if (plan === null) {
        const output = await generateWith(
          deps,
          "First, produce a short numbered plan (2-4 steps) for responding to " +
            "the user's latest message. Reply with ONLY the numbered plan."
        );
        const text = textOf(output.parts);
        const steps = text
          .split("\n")
          .map((line) => line.match(/^\s*\d+[.)]\s*(.+)$/)?.[1])
          .filter((s): s is string => s !== undefined);
        await commitPayload(deps, {
          kind: "planner/plan",
          v: 1,
          steps: steps.length > 0 ? steps : [text.trim()],
          done: 0
        } satisfies PlanPayload);
        return { outcome: "continue" };
      }

      // Phase 2 — execute the next plan step (tools allowed).
      if (plan.done < plan.steps.length) {
        const current = plan.steps[plan.done];
        const output = await generateWith(
          deps,
          `You are executing step ${plan.done + 1} of your plan: "${current}". ` +
            `Use tools if helpful. When the step is done, reply with its outcome in one sentence.`
        );
        const calls = toolCalls(output.parts);
        if (calls.length > 0) {
          await commitMessage(deps, {
            kind: "message",
            v: 1,
            role: "assistant",
            parts: output.parts
          });
          // Claim/settle-governed execution; parks on approval or pending.
          return executeCalls(deps, calls);
        }
        await commitPayload(deps, {
          kind: "planner/note",
          v: 1,
          step: plan.done + 1,
          note: textOf(output.parts)
        } satisfies PlanNotePayload);
        await commitPayload(deps, { ...plan, done: plan.done + 1 });
        return { outcome: "continue" };
      }

      // Phase 3 — every step done: compose the final answer from the notes.
      const notes = await deps.view.query({
        kinds: ["planner/note"],
        turn: deps.turn.turnId,
        limit: plan.steps.length + 4
      });
      const noteText = [...notes]
        .reverse()
        .map((e) => {
          const n = e.payload as PlanNotePayload;
          return `${n.step}. ${n.note}`;
        })
        .join("\n");
      const output = await generateWith(
        deps,
        `Your plan is complete. Step outcomes:\n${noteText}\n` +
          `Now give the user the final answer. Do not mention the plan mechanics.`
      );
      await commitMessage(deps, {
        kind: "message",
        v: 1,
        role: "assistant",
        parts: output.parts
      });
      return { outcome: "completed" };
    }
  };
}

// ---------------------------------------------------------------------------

async function latestPlan(deps: StepDeps): Promise<PlanPayload | null> {
  const found = await deps.view.query({
    kinds: ["planner/plan"],
    turn: deps.turn.turnId,
    limit: 1
  });
  return found.length > 0 ? (found[0].payload as PlanPayload) : null;
}

/** Assemble via the configured ContextAssembler, then append an instruction. */
async function generateWith(deps: StepDeps, instruction: string) {
  const request = await deps.context.assemble({
    view: deps.view,
    turn: deps.turn,
    tools: await deps.tools.catalog(),
    budget: {}
  });
  return deps.model.generate(
    { ...request, system: `${request.system ?? ""}\n\n${instruction}` },
    { onChunk: (chunk) => deps.write(chunk as never), signal: deps.signal }
  );
}

const toolCalls = (parts: readonly Part[]) =>
  parts.filter(
    (p): p is Extract<Part, { type: "tool-call" }> => p.type === "tool-call"
  );

const textOf = (parts: readonly Part[]) =>
  parts
    .filter((p): p is Extract<Part, { type: "text" }> => p.type === "text")
    .map((p) => p.text)
    .join("");

async function commitPayload<P extends Versioned>(
  deps: StepDeps,
  payload: P
): Promise<void> {
  await deps.commit([
    {
      origin: { module: "planner" },
      turn: deps.turn.turnId,
      payload
    } as NewEntry
  ]);
}

async function commitMessage(
  deps: StepDeps,
  payload: MessagePayload
): Promise<void> {
  await deps.commit([
    {
      origin: { module: "harness" },
      turn: deps.turn.turnId,
      payload
    } as NewEntry
  ]);
}
