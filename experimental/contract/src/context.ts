/**
 * context — log view in, language-model request out. assemble() is a pure,
 * deterministic read over committed state: no engine handle, no storage, no
 * policy execution, and no writes during assembly.
 *
 * This is deliberately the emptiest contract in the set. Context engineering
 * is where the meta moves fastest — truncation windows, summary overlays,
 * RAG, capability blocks, structured scratchpads — and under this design
 * every one of those is an implementation of assemble(). A stateful assembler
 * may emit private entries through a separate explicit idempotent path; that
 * writing is not part of assemble().
 *
 * Compaction is one ContextAssembler implementation, not a top-level contract
 * concept. Overflow classification belongs to LanguageModel; reacting to it
 * belongs to the default harness.
 *
 * Allowed imports: kernel, transcript (view), tools (descriptors), model
 * (request types). Type-only, data-only.
 */

import type { TokenBudget, TurnInfo } from "./kernel.js";
import type { LogView } from "./transcript.js";
import type { ToolDescriptor } from "./tools.js";
import type { LanguageModelRequest } from "./model.js";

export interface AssembleInput {
  readonly view: LogView;
  readonly turn: TurnInfo;
  /** Merged catalog, for capability description in the context. */
  readonly tools: readonly ToolDescriptor[];
  readonly budget: TokenBudget;
}

export interface ContextAssembler {
  assemble(input: AssembleInput): Promise<LanguageModelRequest>;
}
