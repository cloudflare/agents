import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type AssistantMessage,
  type FauxContentBlock
} from "pi-ai-dev";
import type { PiModel, PiModels } from "./types";

/** One scripted response accepted by {@link FauxPiRuntime.setResponses}. */
export type FauxPiResponse = object;

/** A controllable pi model runtime for tests and examples without inference. */
export type FauxPiRuntime = {
  readonly models: PiModels;
  readonly model: PiModel;
  /** Replace the responses consumed by later model requests. */
  setResponses(responses: readonly FauxPiResponse[]): void;
};

/** Construct one model-visible tool call for a faux response. */
export function fauxPiToolCall(
  name: string,
  arguments_: Record<string, unknown>
): FauxPiResponse {
  return fauxToolCall(name, arguments_) as FauxPiResponse;
}

/** Construct one complete assistant response for a faux model. */
export function fauxPiAssistantMessage(
  content: string | FauxPiResponse | readonly FauxPiResponse[],
  options: { readonly stopReason?: "stop" | "toolUse" } = {}
): FauxPiResponse {
  // SAFETY: FauxPiResponse values returned by fauxPiToolCall are pi-ai
  // FauxContentBlock values. Strings are accepted directly by the provider.
  return fauxAssistantMessage(
    content as string | FauxContentBlock | FauxContentBlock[],
    options
  ) as FauxPiResponse;
}

/** Create a controllable, no-network pi model runtime. */
export function createFauxPiRuntime(): FauxPiRuntime {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  return {
    models,
    model: faux.getModel(),
    setResponses: (responses) => {
      // SAFETY: All public FauxPiResponse constructors above return the
      // AssistantMessage values accepted by the upstream faux provider.
      faux.setResponses(responses as AssistantMessage[]);
    }
  };
}
