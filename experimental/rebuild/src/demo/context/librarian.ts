/**
 * DEMO MODULE — ContextAssembler, the wacky one.
 *
 * The Librarian: an assembler that contains a MODEL. Before the thinking
 * model sees anything, a second (typically smaller/cheaper) model reads a
 * catalog of recent log entries and picks which ones matter for the latest
 * message. Model-curated retrieval as a pure context strategy — the scoped
 * down version of an RLM that delegates context construction wholesale.
 *
 * Contract note: assemble() stays WRITE-free (safe to re-run) but is no
 * longer deterministic — the librarian may curate differently on a retry.
 * The contract tolerates this; it is the interesting edge of "pure read".
 */

import type {
  ContextAssembler,
  LanguageModel,
  MessagePayload,
  Part
} from "../../contract";

export interface LibrarianOptions {
  readonly system?: string;
  /** The curator. A small model is the point — cheap reads, big model thinks. */
  readonly librarian: LanguageModel;
  /** How many recent entries the librarian may choose from. */
  readonly shortlist?: number;
  /** How many it may pick. */
  readonly pick?: number;
}

export function librarian(opts: LibrarianOptions): ContextAssembler {
  return {
    async assemble(input) {
      const newestFirst = await input.view.query({
        kinds: ["message"],
        limit: opts.shortlist ?? 30
      });
      const chronological = [...newestFirst].reverse();
      const latest = chronological[chronological.length - 1];

      const catalog = chronological
        .map((e) => `#${e.ref.seq} [${(e.payload as MessagePayload).role}] ${snippet(e.payload as MessagePayload)}`)
        .join("\n");

      const curated = await opts.librarian.generate(
        {
          system:
            `You are a librarian curating context for another model. ` +
            `Given the catalog, reply with ONLY the #numbers (comma-separated, ` +
            `max ${opts.pick ?? 8}) of the entries needed to answer the newest message well.`,
          messages: [
            {
              role: "user",
              parts: [{ type: "text", text: catalog }]
            }
          ]
        },
        {}
      );
      const reply = curated.parts
        .filter((p): p is Extract<Part, { type: "text" }> => p.type === "text")
        .map((p) => p.text)
        .join("");
      const chosen = new Set([...reply.matchAll(/\d+/g)].map((m) => Number(m[0])));

      const selected = chronological.filter(
        // The newest message is always included — the librarian curates
        // supporting material, it cannot drop the question itself.
        (e) => chosen.has(e.ref.seq) || e === latest
      );
      return {
        ...(opts.system !== undefined ? { system: opts.system } : {}),
        messages: selected.map((e) => {
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
  };
}

function snippet(m: MessagePayload): string {
  const text = m.parts
    .map((p) => (p.type === "text" ? p.text : `<${p.type}>`))
    .join(" ");
  return text.length > 80 ? `${text.slice(0, 77)}...` : text;
}
