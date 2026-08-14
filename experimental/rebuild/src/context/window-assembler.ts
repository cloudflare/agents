/**
 * A windowed ContextAssembler: the newest N message entries, chronologically
 * reversed, plus a static system prompt. Deliberately the simplest possible
 * strategy — the point is that it is a pure read over LogView.query and that
 * swapping it for RAG/compaction/etc. is a one-field change.
 */

import type {
  AssembleInput,
  ContextAssembler,
  LanguageModelMessage,
  LanguageModelRequest,
  MessagePayload
} from "../contract.js";

export interface WindowAssemblerOptions {
  readonly system?: string;
  /** How many newest message entries the model sees. */
  readonly windowSize?: number;
}

export function windowAssembler(
  opts: WindowAssemblerOptions = {}
): ContextAssembler {
  const windowSize = opts.windowSize ?? 50;
  return {
    async assemble(input: AssembleInput): Promise<LanguageModelRequest> {
      const newestFirst = await input.view.query({
        kinds: ["message"],
        limit: windowSize
      });
      const messages: LanguageModelMessage[] = [...newestFirst]
        .reverse()
        .map((entry) => {
          const payload = entry.payload as MessagePayload;
          return { role: payload.role, parts: payload.parts };
        });
      const request: {
        system?: string;
        messages: LanguageModelMessage[];
        tools: { name: string; description: string; input: object }[];
      } = {
        messages,
        tools: input.tools.map((t) => ({
          name: t.name,
          description: t.description,
          input: t.input
        }))
      };
      if (opts.system !== undefined) request.system = opts.system;
      return request as LanguageModelRequest;
    }
  };
}
