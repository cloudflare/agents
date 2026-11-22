/**
 * AI SDK telemetry settings for a Think turn. The class names the logical
 * agent, the instance name the agent resource and the Durable Object id its
 * one conversation. Values the caller set in `beforeTurn` win.
 */

import type { streamText } from "ai";

/** @internal */
export type TurnTelemetrySettings = Parameters<
  typeof streamText
>[0]["experimental_telemetry"];

/**
 * The admitted turn the telemetry describes.
 *
 * @internal
 */
export interface TelemetryTurn {
  readonly requestId: string;
  readonly trigger: string;
  readonly admission: string;
  readonly channel?: string;
  readonly continuation?: boolean;
  readonly generation?: number;
}

/** @internal */
export interface TelemetryIdentity {
  /** Default `functionId` (AI SDK maps it to `gen_ai.agent.name`). */
  readonly className: string;
  readonly agentId: string;
  readonly conversationId: string;
  /** The admitted turn of this agent, when the inference runs inside one. */
  readonly turn?: TelemetryTurn;
}

/** The turn attributes every telemetry record carries. */
function turnAttributes(turn: TelemetryTurn | undefined) {
  if (!turn) return {};
  return {
    "cloudflare.agents.turn.request_id": turn.requestId,
    "cloudflare.agents.turn.trigger": turn.trigger,
    "cloudflare.agents.turn.admission": turn.admission,
    ...(turn.channel !== undefined && {
      "cloudflare.agents.turn.channel": turn.channel
    }),
    ...(turn.continuation !== undefined && {
      "cloudflare.agents.turn.continuation": turn.continuation
    }),
    ...(turn.generation !== undefined && {
      "cloudflare.agents.turn.generation": turn.generation
    })
  };
}

function settingsOf(base: TurnTelemetrySettings): {
  settings: Record<string, unknown>;
  metadata: Record<string, unknown>;
  functionId: (className: string) => string;
} {
  const settings = (base ?? {}) as unknown as Record<string, unknown>;
  const metadata =
    typeof settings.metadata === "object" && settings.metadata !== null
      ? (settings.metadata as Record<string, unknown>)
      : {};
  return {
    settings,
    metadata,
    functionId: (className) =>
      typeof settings.functionId === "string" ? settings.functionId : className
  };
}

/**
 * AI SDK v6 `experimental_telemetry` for a turn.
 *
 * @internal
 */
export function turnTelemetryV6(
  base: TurnTelemetrySettings,
  identity: TelemetryIdentity
): TurnTelemetrySettings {
  const { settings, metadata, functionId } = settingsOf(base);
  return {
    ...settings,
    functionId: functionId(identity.className),
    metadata: {
      agentId: identity.agentId,
      conversationId: identity.conversationId,
      ...turnAttributes(identity.turn),
      // beforeTurn remains authoritative. metadata.agentName, when supplied,
      // also takes precedence over functionId in the tracing adapter.
      ...metadata
    }
  } as unknown as TurnTelemetrySettings;
}

/**
 * AI SDK v7 `telemetry` options and `runtimeContext` for a turn.
 *
 * @internal
 */
export function turnTelemetryV7(
  base: TurnTelemetrySettings,
  identity: TelemetryIdentity
): {
  options: Record<string, unknown>;
  runtimeContext: Record<string, unknown>;
} {
  const { settings, metadata, functionId } = settingsOf(base);
  const runtimeContext: Record<string, unknown> = {
    agentId: identity.agentId,
    conversationId: identity.conversationId,
    ...turnAttributes(identity.turn),
    ...metadata
  };
  const includedContext =
    typeof settings.includeRuntimeContext === "object" &&
    settings.includeRuntimeContext !== null
      ? (settings.includeRuntimeContext as Record<string, boolean>)
      : {};
  const localIntegrations = settings.integrations;
  const globalIntegrations = (
    globalThis as typeof globalThis & {
      AI_SDK_TELEMETRY_INTEGRATIONS?: unknown[];
    }
  ).AI_SDK_TELEMETRY_INTEGRATIONS;
  const integrations = [
    ...(localIntegrations !== undefined
      ? Array.isArray(localIntegrations)
        ? localIntegrations
        : [localIntegrations]
      : (globalIntegrations ?? []))
  ];
  const options: Record<string, unknown> = {
    ...settings,
    functionId: functionId(identity.className),
    includeRuntimeContext: {
      ...Object.fromEntries(
        Object.keys(runtimeContext).map((key) => [key, true])
      ),
      ...includedContext
    },
    integrations
  };
  delete options.metadata;
  return { options, runtimeContext };
}
