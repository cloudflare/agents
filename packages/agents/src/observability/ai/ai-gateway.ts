const MAX_AI_GATEWAY_LOG_ID_BYTES = 256;
const AI_GATEWAY_CONTAINER_KEYS = new Set([
  "aigateway",
  "binding",
  "cause",
  "cloudflare",
  "config",
  "context",
  "error",
  "gateway",
  "providermetadata",
  "rawresponse",
  "response",
  "workersai"
]);

/**
 * Reads an AI Gateway log id from explicit provider surfaces only: response
 * headers, provider metadata, gateway errors, or a Workers AI binding. The
 * walk is bounded and uses data-property descriptors, so telemetry cannot get
 * stuck on cycles or invoke arbitrary application getters. Unknown shapes fail
 * open and simply omit the attribute.
 */
export function extractAIGatewayLogId(value: unknown): string | undefined {
  const seen = new Set<object>();
  let visited = 0;

  const visit = (
    candidate: unknown,
    depth: number,
    gatewayScoped: boolean,
    providerMetadata: boolean,
    responseScoped: boolean
  ): string | undefined => {
    if (
      candidate === null ||
      candidate === undefined ||
      depth > 6 ||
      (typeof candidate !== "object" && typeof candidate !== "function") ||
      seen.has(candidate) ||
      visited >= 200
    ) {
      return undefined;
    }
    seen.add(candidate);
    visited += 1;

    if (typeof Response !== "undefined" && candidate instanceof Response) {
      return readHeaderLogId(candidate.headers);
    }

    let descriptors: PropertyDescriptorMap;
    try {
      descriptors = Object.getOwnPropertyDescriptors(candidate);
    } catch {
      return undefined;
    }

    const objectName = dataString(descriptors.name);
    const scopedHere =
      gatewayScoped ||
      (objectName !== undefined && isGatewayKey(normalizeKey(objectName)));

    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (!("value" in descriptor)) {
        continue;
      }

      const normalizedKey = normalizeKey(key);
      if (
        normalizedKey === "cfaiglogid" ||
        normalizedKey === "aigatewaylogid"
      ) {
        const logId = boundedAIGatewayLogId(descriptor.value);
        if (logId !== undefined) {
          return logId;
        }
      }

      if (
        normalizedKey === "responseheaders" ||
        (normalizedKey === "headers" && responseScoped)
      ) {
        const logId = readHeaderLogId(descriptor.value);
        if (logId !== undefined) {
          return logId;
        }
      }

      if (normalizedKey === "logid" && scopedHere) {
        const logId = boundedAIGatewayLogId(descriptor.value);
        if (logId !== undefined) {
          return logId;
        }
      }
    }

    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (!("value" in descriptor)) {
        continue;
      }
      const normalizedKey = normalizeKey(key);
      if (!providerMetadata && !AI_GATEWAY_CONTAINER_KEYS.has(normalizedKey)) {
        continue;
      }

      const nested = visit(
        descriptor.value,
        depth + 1,
        scopedHere || isGatewayKey(normalizedKey),
        providerMetadata || normalizedKey === "providermetadata",
        normalizedKey === "response" || normalizedKey === "rawresponse"
      );
      if (nested !== undefined) {
        return nested;
      }
    }

    return undefined;
  };

  return visit(value, 0, false, false, false);
}

/** Per-wrapped-model view of a Workers AI binding's latest response log id. */
export type AIGatewayLogCapture = {
  readonly model: object;
  get(): string | undefined;
  reset(): void;
};

/**
 * workers-ai-provider currently exposes the gateway ID on its `Ai` binding,
 * not in the LanguageModel result. Clone only that known runtime shape and
 * proxy `binding.run` so the ID is captured as that call settles instead of
 * reading the binding's mutable latest value later when the span ends.
 */
export function captureAIGatewayLogFromModel(
  model: object,
  provider: string | undefined
): AIGatewayLogCapture {
  let logId: string | undefined;
  const capture = {
    model,
    get: () => logId,
    reset: () => {
      logId = undefined;
    }
  };

  if (!provider?.toLowerCase().startsWith("workersai")) {
    return capture;
  }

  try {
    const modelDescriptors = Object.getOwnPropertyDescriptors(model);
    const configDescriptor = modelDescriptors.config;
    if (!configDescriptor || !("value" in configDescriptor)) {
      return capture;
    }

    const config = configDescriptor.value;
    if (typeof config !== "object" || config === null) {
      return capture;
    }
    const configDescriptors = Object.getOwnPropertyDescriptors(config);
    const bindingDescriptor = configDescriptors.binding;
    if (!bindingDescriptor || !("value" in bindingDescriptor)) {
      return capture;
    }

    const binding = bindingDescriptor.value;
    if (
      typeof binding !== "object" ||
      binding === null ||
      !("aiGatewayLogId" in binding) ||
      typeof (binding as { run?: unknown }).run !== "function"
    ) {
      return capture;
    }

    const bindingProxy = new Proxy(binding, {
      get(target, property, receiver) {
        if (property !== "run") {
          return Reflect.get(target, property, receiver);
        }

        return (...args: readonly unknown[]) => {
          const run = Reflect.get(target, property, target) as (
            ...runArgs: readonly unknown[]
          ) => unknown;
          const previousLogId = extractAIGatewayLogId(target);
          logId = undefined;
          const captureResult = (result: unknown): void => {
            const resultLogId = extractAIGatewayLogId(result);
            const currentLogId = extractAIGatewayLogId(target);
            logId =
              resultLogId ??
              (currentLogId !== previousLogId ? currentLogId : undefined);
          };
          try {
            return Promise.resolve(Reflect.apply(run, target, args)).then(
              (result) => {
                captureResult(result);
                return result;
              },
              (cause: unknown) => {
                captureResult(cause);
                throw cause;
              }
            );
          } catch (cause: unknown) {
            captureResult(cause);
            throw cause;
          }
        };
      }
    });

    const configClone = Object.create(Object.getPrototypeOf(config), {
      ...configDescriptors,
      binding: { ...bindingDescriptor, value: bindingProxy }
    }) as object;
    capture.model = Object.create(Object.getPrototypeOf(model), {
      ...modelDescriptors,
      config: { ...configDescriptor, value: configClone }
    }) as object;
  } catch {
    // Unknown/frozen/proxied provider shape: keep the original model. Header
    // and provider-metadata extraction still work when the result exposes them.
  }

  return capture;
}

function readHeaderLogId(value: unknown): string | undefined {
  if (isHeadersLike(value)) {
    try {
      return boundedAIGatewayLogId(value.get("cf-aig-log-id"));
    } catch {
      return undefined;
    }
  }
  if (typeof value !== "object" || value === null) {
    return undefined;
  }

  let descriptors: PropertyDescriptorMap;
  try {
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    return undefined;
  }
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if ("value" in descriptor && key.toLowerCase() === "cf-aig-log-id") {
      return boundedAIGatewayLogId(descriptor.value);
    }
  }
  return undefined;
}

function isHeadersLike(
  value: unknown
): value is { get(name: string): string | null } {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  try {
    return "get" in value && typeof value.get === "function";
  } catch {
    return false;
  }
}

function isGatewayKey(value: string): boolean {
  return (
    value.includes("gateway") ||
    value.includes("aig") ||
    value.includes("workersai") ||
    value === "cloudflare"
  );
}

function normalizeKey(value: string): string {
  return value.toLowerCase().replaceAll(/[-_.]/g, "");
}

function dataString(
  descriptor: PropertyDescriptor | undefined
): string | undefined {
  return descriptor && "value" in descriptor
    ? nonEmptyString(descriptor.value)
    : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function boundedAIGatewayLogId(value: unknown): string | undefined {
  const id = nonEmptyString(value);
  return id !== undefined &&
    new TextEncoder().encode(id).length <= MAX_AI_GATEWAY_LOG_ID_BYTES
    ? id
    : undefined;
}
