/**
 * Per-request option resolution for pi-ai calls: pi's call options and the
 * per-model options become one resolved request that every wire consumes.
 */

import type {
  Api,
  Context,
  Model,
  SimpleStreamOptions,
  StreamOptions,
  ThinkingLevel
} from "@earendil-works/pi-ai";
import { clampThinkingLevel } from "@earendil-works/pi-ai";
import type {
  GatewayOptions,
  ModelOptions,
  ProviderGatewaySettings,
  ResolvedOptions
} from "../core/settings";
import { resolveOptions } from "../core/settings";
import type { Transport } from "../core/transport";
import { CLOUDFLARE_AI_API, optionsOf } from "./catalog";
import { DEFAULT_STREAM_IDLE_TIMEOUT_MS } from "./wires/shared";

/** What `createAI` fixes for every request. */
export interface StreamConfig {
  transport: Transport;
  /** The `createAI` settings, whose gateway keys are the lowest layer. */
  providerGateway: string | ProviderGatewaySettings | undefined;
}

/** pi-ai's provider-neutral tool choice, in OpenAI's shape. */
export type ToolChoice =
  | "auto"
  | "none"
  | "required"
  | { type: "function"; function: { name: string } };

/** Everything a wire needs, resolved once per request. */
export interface WireRequest {
  model: Model<Api>;
  context: Context;
  /** The pi-ai call options; simple options carry `reasoning`. */
  options: SimpleStreamOptions;
  /** Whether this came through `streamSimple` (reasoning is a level). */
  simple: boolean;
  resolved: ResolvedOptions;
  /**
   * Legs to try if this one fails before producing output. A leg may be a
   * model object as well as an id, so this list — rather than
   * {@link ResolvedOptions.fallback}, which is ids only — is what the
   * dispatcher walks.
   */
  fallback: (string | Model<Api>)[];
  /** Request headers after gateway and affinity merging. */
  headers: Record<string, string>;
  /**
   * The reasoning effort to send, `null` to disable, `undefined` to omit.
   *
   * For a Workers AI model it is already collapsed onto the three levels the
   * compat layer's quirk table declares. For every other model it is the
   * model's own clamped thinking level, un-mapped: each wire applies that
   * model's `thinkingLevelMap` itself, exactly as pi-ai's own implementations
   * do, so no effort table of ours ever reaches a vendor.
   */
  reasoningEffort: string | null | undefined;
  toolChoice: ToolChoice | undefined;
  streamIdleTimeoutMs: number;
}

/** The pi thinking levels, for reading a caller's explicit effort. */
const THINKING_LEVELS: readonly string[] = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh"
];

function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return typeof value === "string" && THINKING_LEVELS.includes(value);
}

/**
 * Resolves a pi thinking level onto the effort a request carries.
 *
 * Workers AI is the one catalog with an effort scale of ours: its quirk table
 * declares three levels, so the run path collapses onto them. Every other
 * model keeps its own level name — the wire then applies the model's own
 * `thinkingLevelMap`, the way pi-ai's implementations do — because a table of
 * ours has no business deciding a vendor's efforts.
 */
function effortForLevel(
  model: Model<Api>,
  level: ThinkingLevel | undefined
): string | undefined {
  if (level === undefined || !model.reasoning) return undefined;
  const clamped = clampThinkingLevel(model, level);
  if (clamped === "off") return undefined;
  if (model.api !== CLOUDFLARE_AI_API) return clamped;
  switch (clamped) {
    case "minimal":
    case "low":
      return "low";
    case "medium":
      return "medium";
    case "high":
    case "xhigh":
      return "high";
    default: {
      const exhaustive: never = clamped;
      return exhaustive;
    }
  }
}

/** Scalars only: the gateway rejects nested metadata. */
function scalarMetadata(
  metadata: Record<string, unknown> | undefined
): GatewayOptions["metadata"] {
  if (metadata === undefined) return undefined;
  const result: NonNullable<GatewayOptions["metadata"]> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (
      value === null ||
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      result[key] = value;
    }
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

/** pi headers allow `null` to suppress a default; those are dropped here. */
function stringHeaders(
  headers: StreamOptions["headers"]
): Record<string, string> | undefined {
  if (headers === undefined) return undefined;
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === "string") result[key] = value;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

/** The per-call layer of options, read off pi-ai's call options. */
function callLayer(options: SimpleStreamOptions): ModelOptions {
  const layer: ModelOptions = {};
  const headers = stringHeaders(options.headers);
  if (headers !== undefined) layer.headers = headers;
  const metadata = scalarMetadata(options.metadata);
  if (metadata !== undefined) layer.metadata = metadata;
  if (options.sessionId !== undefined)
    layer.sessionAffinity = options.sessionId;
  return layer;
}

function toolChoiceOf(options: SimpleStreamOptions): ToolChoice | undefined {
  const raw = (options as { toolChoice?: unknown }).toolChoice;
  if (raw === "auto" || raw === "none" || raw === "required") return raw;
  if (raw === "any") return "required";
  if (raw !== null && typeof raw === "object") {
    const record = raw as {
      type?: unknown;
      name?: unknown;
      function?: { name?: unknown };
    };
    const name =
      typeof record.function?.name === "string"
        ? record.function.name
        : typeof record.name === "string"
          ? record.name
          : undefined;
    if (name !== undefined) return { function: { name }, type: "function" };
  }
  return undefined;
}

export function buildRequest(
  model: Model<Api>,
  context: Context,
  options: SimpleStreamOptions,
  simple: boolean,
  config: StreamConfig
): WireRequest {
  const modelOptions = optionsOf(model);
  const resolved = resolveOptions(
    config.providerGateway,
    modelOptions,
    callLayer(options)
  );
  const headers: Record<string, string> = { ...resolved.headers };
  // Session affinity is a Workers AI replica hint, sent as a request header on
  // the run path; it means nothing to a third-party vendor.
  if (
    resolved.sessionAffinity !== undefined &&
    model.api === CLOUDFLARE_AI_API
  ) {
    headers["x-session-affinity"] = resolved.sessionAffinity;
  }
  const explicitEffort = (options as { reasoningEffort?: unknown })
    .reasoningEffort;
  // An explicitly named level goes through the same model-aware resolution as
  // `reasoning` does, so `"xhigh"` and `"minimal"` survive on a model whose
  // own metadata declares them; anything else a caller wrote is theirs.
  const reasoningEffort =
    resolved.reasoningEffort !== undefined
      ? resolved.reasoningEffort
      : isThinkingLevel(explicitEffort)
        ? effortForLevel(model, explicitEffort)
        : explicitEffort === "off"
          ? undefined
          : typeof explicitEffort === "string"
            ? explicitEffort
            : simple
              ? effortForLevel(model, options.reasoning)
              : undefined;
  return {
    context,
    fallback: modelOptions?.fallback ?? [],
    headers,
    model,
    options,
    reasoningEffort,
    resolved,
    simple,
    streamIdleTimeoutMs:
      modelOptions?.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS,
    toolChoice: toolChoiceOf(options)
  };
}
