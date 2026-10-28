import { context, diag, trace } from "@opentelemetry/api";
import type { OpenTelemetryBridge } from "./bridge";

/** Where `@opentelemetry/api` 1.x keeps its global registrations. */
const OTEL_GLOBAL = Symbol.for("opentelemetry.js.api.1");

type OtelGlobal = {
  readonly version?: string;
  readonly context?: unknown;
  readonly trace?: unknown;
};

/** What happened when the bridge was offered to the global OTel API. */
export type RegistrationOutcome =
  | "registered"
  | "already-registered"
  | "deferred";

function otelGlobal(): OtelGlobal | undefined {
  return (globalThis as Record<symbol, OtelGlobal | undefined>)[OTEL_GLOBAL];
}

/** The provider behind the global proxy, when the proxy exposes it. */
function delegateOf(provider: unknown): unknown {
  const proxy = provider as { getDelegate?: () => unknown } | null | undefined;
  return typeof proxy?.getDelegate === "function"
    ? proxy.getDelegate()
    : provider;
}

/**
 * Registers `bridge` as the global OTel context manager and tracer provider.
 *
 * - Idempotent while the bridge is registered.
 * - Steps aside (`"deferred"`) when both globals are already registered by
 *   someone else: an OTel SDK the application set up, or the Workers runtime
 *   once it registers the OTel API natively. The existing setup keeps working.
 * - Throws when only one of the two is registered, or the registry belongs to
 *   an incompatible `@opentelemetry/api` copy: either would leave OTel spans
 *   silently detached from native tracing.
 */
export function registerBridge(
  bridge: OpenTelemetryBridge
): RegistrationOutcome {
  const registry = otelGlobal();
  const contextOwner = registry?.context;
  const traceOwner = registry?.trace;
  const ownsContext = contextOwner === bridge.contextManager;
  const ownsTrace =
    traceOwner !== undefined &&
    delegateOf(traceOwner) === bridge.tracerProvider;

  if (ownsContext && ownsTrace) {
    return "already-registered";
  }
  if (
    contextOwner !== undefined &&
    traceOwner !== undefined &&
    !ownsContext &&
    !ownsTrace
  ) {
    diag.info(
      "agents/observability: OpenTelemetry is already registered; experimental_registerOpenTelemetry() left it in place."
    );
    return "deferred";
  }
  if (contextOwner !== undefined || traceOwner !== undefined) {
    throw new Error(
      `experimental_registerOpenTelemetry(): an OpenTelemetry ${contextOwner === undefined ? "tracer provider" : "context manager"} is already registered without its ${contextOwner === undefined ? "context manager" : "tracer provider"}. Remove the partial OpenTelemetry setup, or register both before calling experimental_registerOpenTelemetry().`
    );
  }

  if (!context.setGlobalContextManager(bridge.contextManager)) {
    throw incompatible(registry?.version);
  }
  bridge.contextManager.enable();
  if (!trace.setGlobalTracerProvider(bridge.tracerProvider)) {
    // Roll back only the manager installed above.
    context.disable();
    throw incompatible(registry?.version);
  }
  return "registered";
}

function incompatible(version: string | undefined): Error {
  return new Error(
    `experimental_registerOpenTelemetry(): the global OpenTelemetry API rejected the registration${version === undefined ? "" : ` (globals were created by @opentelemetry/api ${version})`}. Install a single version of @opentelemetry/api.`
  );
}
