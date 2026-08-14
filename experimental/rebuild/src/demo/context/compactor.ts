/**
 * DEMO MODULE — ContextAssembler, the practical one.
 *
 * Compaction with the engine knowing nothing about it. The strategy owns a
 * private pass-through entry kind, "compactor/summary": every other module
 * skips it (tolerant readers), and this module reads it back as vocabulary
 * between itself and its future self.
 *
 * Two halves, because assemble() is a pure read and may not write:
 * - assemble(): latest summary + the message tail after it → request.
 * - withCompaction(): an AgentLoop DECORATOR that, before delegating,
 *   summarizes aged history through a model and commits the summary entry.
 *   Loops compose like middleware; a crash that duplicates a summary is
 *   benign because reads take the latest.
 */

import type {
  AgentLoop,
  ContextAssembler,
  Entry,
  LanguageModel,
  MessagePayload,
  NewEntry,
  Seq,
  StepDeps,
  Versioned
} from "../../contract";

export interface SummaryPayload extends Versioned {
  readonly kind: "compactor/summary";
  readonly v: 1;
  readonly summary: string;
  /** Messages at or below this seq are covered by the summary. */
  readonly upTo: Seq;
}

export interface CompactorOptions {
  readonly system?: string;
  /** Model used to write summaries (can differ from the thinking model). */
  readonly summarizer: LanguageModel;
  /** Messages that always stay verbatim. */
  readonly keepRecent?: number;
  /** Compact when the un-summarized tail exceeds this. */
  readonly highWater?: number;
}

export function compactor(opts: CompactorOptions): {
  assembler: ContextAssembler;
  withCompaction(inner: AgentLoop): AgentLoop;
} {
  const keepRecent = opts.keepRecent ?? 6;
  const highWater = opts.highWater ?? 16;

  async function latestSummary(view: StepDeps["view"]): Promise<SummaryPayload | null> {
    const found = await view.query({ kinds: ["compactor/summary"], limit: 1 });
    return found.length > 0 ? (found[0].payload as SummaryPayload) : null;
  }

  async function tailAfter(view: StepDeps["view"], upTo: Seq): Promise<readonly Entry[]> {
    const newestFirst = await view.query({ kinds: ["message"], after: upTo });
    return [...newestFirst].reverse();
  }

  return {
    assembler: {
      async assemble(input) {
        const summary = await latestSummary(input.view);
        const tail = await tailAfter(input.view, summary?.upTo ?? 0);
        const system =
          (opts.system ?? "") +
          (summary !== null
            ? `\n\nEarlier conversation, summarized:\n${summary.summary}`
            : "");
        return {
          ...(system.length > 0 ? { system } : {}),
          messages: tail.map((e) => {
            const m = e.payload as MessagePayload;
            return { role: m.role, parts: m.parts };
          }),
          tools: input.tools.map((t) => ({
            name: t.name,
            description: t.description,
            input: t.input
          }))
        };
      }
    },

    withCompaction(inner: AgentLoop): AgentLoop {
      return {
        async step(deps) {
          const summary = await latestSummary(deps.view);
          const tail = await tailAfter(deps.view, summary?.upTo ?? 0);
          if (tail.length > highWater) {
            const aging = tail.slice(0, tail.length - keepRecent);
            const output = await opts.summarizer.generate(
              {
                system:
                  "Summarize this conversation fragment in a compact paragraph. " +
                  "Preserve names, decisions, and unresolved questions." +
                  (summary !== null ? `\nEarlier summary to fold in:\n${summary.summary}` : ""),
                messages: aging.map((e) => {
                  const m = e.payload as MessagePayload;
                  return { role: m.role, parts: m.parts };
                })
              },
              { signal: deps.signal }
            );
            const text = output.parts
              .filter((p): p is Extract<typeof p, { type: "text" }> => p.type === "text")
              .map((p) => p.text)
              .join("");
            const payload: SummaryPayload = {
              kind: "compactor/summary",
              v: 1,
              summary: text,
              upTo: aging[aging.length - 1].ref.seq
            };
            await deps.commit([
              { origin: { module: "compactor" }, payload } as NewEntry
            ]);
          }
          return inner.step(deps);
        }
      };
    }
  };
}
