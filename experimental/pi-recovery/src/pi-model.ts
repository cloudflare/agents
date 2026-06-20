/**
 * Deterministic pi model for the recovery harness.
 *
 * Uses pi-ai's built-in `registerFauxProvider` so the pi `Agent` streams through
 * its REAL stream path (`streamSimple` → faux provider → `AssistantMessageEvent`
 * stream → `AgentEvent`s) with NO network and NO real LLM. `tokensPerSecond` is
 * set low so a turn streams over several seconds — long enough for a `wrangler
 * dev` SIGKILL to interrupt it MID-STREAM and exercise fiber recovery, exactly
 * like the AI SDK e2e's 1-chunk/second slow stream.
 *
 * @internal Validation fixture, not a published package.
 */

import {
  fauxAssistantMessage,
  registerFauxProvider,
  type Model
} from "@earendil-works/pi-ai";

const FAUX_API = "faux";
const FAUX_PROVIDER = "faux";
const FAUX_MODEL_ID = "faux-recovery";

/** A registered faux pi model plus controls for scripting turns. */
export interface FauxPiModel {
  model: Model<string>;
  /** Script the assistant text the NEXT turn streams. */
  setNextTurnText(text: string): void;
}

/**
 * Register a faux pi provider that streams `text` at `tokensPerSecond`. The
 * registry is process-global within the isolate, so this is idempotent per
 * `(api, provider)` — re-registering replaces the prior registration, which is
 * what we want when the DO is re-created on a wake.
 */
export function createFauxPiModel(options: {
  tokensPerSecond: number;
}): FauxPiModel {
  const registration = registerFauxProvider({
    api: FAUX_API,
    provider: FAUX_PROVIDER,
    tokensPerSecond: options.tokensPerSecond,
    models: [{ id: FAUX_MODEL_ID, name: "Faux Recovery Model" }]
  });

  return {
    model: registration.getModel(),
    setNextTurnText(text: string): void {
      registration.setResponses([fauxAssistantMessage(text)]);
    }
  };
}
