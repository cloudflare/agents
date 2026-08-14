/**
 * DEMO MODULE — AgentLoop, the wacky one.
 *
 * The debater argues with itself before answering: alternating personas
 * commit "debater/argument" entries (pass-through — never chat messages),
 * and the final step answers informed by the whole exchange. A visibly
 * different style of thinking, dropped into the same harness: the debate
 * survives crashes like everything else because each argument is a
 * committed entry, and the step count picks up exactly where it left off.
 */

import type { AgentLoop, MessagePayload, NewEntry, Part, StepDeps, Versioned } from "../../contract";

export interface ArgumentPayload extends Versioned {
  readonly kind: "debater/argument";
  readonly v: 1;
  readonly persona: string;
  readonly position: string;
}

const PERSONAS = ["The Advocate", "The Skeptic"] as const;

export function debater(opts: { arguments?: number } = {}): AgentLoop {
  const total = opts.arguments ?? 3;
  return {
    async step(deps) {
      const prior = await deps.view.query({
        kinds: ["debater/argument"],
        turn: deps.turn.turnId,
        limit: total + 1
      });
      const argued = [...prior].reverse().map((e) => e.payload as ArgumentPayload);

      if (argued.length < total) {
        const persona = PERSONAS[argued.length % PERSONAS.length];
        const output = await generateWith(
          deps,
          argued,
          `You are ${persona}. In at most two sentences, argue ${
            persona === "The Advocate"
              ? "FOR the most direct way to answer the user's latest message."
              : "AGAINST the previous argument — what does it miss?"
          }`
        );
        const payload: ArgumentPayload = {
          kind: "debater/argument",
          v: 1,
          persona,
          position: textOf(output.parts)
        };
        await deps.commit([
          { origin: { module: "debater" }, turn: deps.turn.turnId, payload } as NewEntry
        ]);
        return { outcome: "continue" };
      }

      const output = await generateWith(
        deps,
        argued,
        "The debate is over. Answer the user's latest message, informed by the " +
          "strongest points on both sides. Do not mention the debate."
      );
      const answer: MessagePayload = {
        kind: "message",
        v: 1,
        role: "assistant",
        parts: output.parts
      };
      await deps.commit([
        { origin: { module: "harness" }, turn: deps.turn.turnId, payload: answer } as NewEntry
      ]);
      return { outcome: "completed" };
    }
  };
}

async function generateWith(
  deps: StepDeps,
  argued: readonly ArgumentPayload[],
  instruction: string
) {
  const request = await deps.context.assemble({
    view: deps.view,
    turn: deps.turn,
    tools: [],
    budget: {}
  });
  const debate = argued.map((a) => `${a.persona}: ${a.position}`).join("\n");
  return deps.model.generate(
    {
      ...request,
      system: `${request.system ?? ""}\n\n${debate.length > 0 ? `Debate so far:\n${debate}\n\n` : ""}${instruction}`
    },
    { onChunk: (chunk) => deps.write(chunk as never), signal: deps.signal }
  );
}

const textOf = (parts: readonly Part[]) =>
  parts
    .filter((p): p is Extract<Part, { type: "text" }> => p.type === "text")
    .map((p) => p.text)
    .join("");
