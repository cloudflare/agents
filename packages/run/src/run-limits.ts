import { RunError } from "./run-error";
import type { RunLimits } from "./run-types";

/** Fully resolved values for every configurable Run limit. */
export type RunResolvedLimits = Readonly<Required<RunLimits>>;

/** The two host-call limits enforced at dispatch time. */
export type RunHostCallLimits = Pick<
  RunResolvedLimits,
  "maxHostFunctionCalls" | "maxConcurrentHostFunctionCalls"
>;

interface RunLimitRule {
  readonly defaultValue: number;
  readonly minimum: number;
  readonly maximum: number;
}

/** The complete specification table of Run limit defaults, minima, and hard maxima. */
const RUN_LIMIT_RULES: Readonly<Record<keyof RunLimits, RunLimitRule>> = {
  timeoutMs: { defaultValue: 30_000, minimum: 1, maximum: 300_000 },
  cpuMs: { defaultValue: 5_000, minimum: 1, maximum: 300_000 },
  subRequests: { defaultValue: 256, minimum: 1, maximum: 10_000 },
  maxSourceBytes: { defaultValue: 262_144, minimum: 1, maximum: 1_048_576 },
  maxLogBytes: { defaultValue: 262_144, minimum: 25, maximum: 1_048_576 },
  maxHostFunctionCalls: { defaultValue: 256, minimum: 1, maximum: 4_096 },
  maxConcurrentHostFunctionCalls: { defaultValue: 8, minimum: 1, maximum: 32 }
};

function throwInvalidRunLimit(name: keyof RunLimits): never {
  throw new RunError("Run limits must use supported integer ranges.", {
    code: "RUN_INVALID_INPUT",
    details: { path: `limits.${name}`, limit: name }
  });
}

function parseRunLimit(limits: RunLimits, name: keyof RunLimits): number {
  const rule = RUN_LIMIT_RULES[name];
  let override: unknown;
  try {
    override = limits[name];
  } catch {
    return throwInvalidRunLimit(name);
  }
  if (override === undefined) return rule.defaultValue;
  if (
    typeof override !== "number" ||
    !Number.isSafeInteger(override) ||
    override < rule.minimum ||
    override > rule.maximum
  ) {
    return throwInvalidRunLimit(name);
  }
  return override;
}

/** Validate every configured limit override and resolve specification defaults. */
export function parseRunLimits(
  limits: RunLimits | undefined
): RunResolvedLimits {
  if (limits === undefined) return parseRunLimits({});
  if (typeof limits !== "object" || limits === null) {
    throw new RunError("Run limits must be a plain object.", {
      code: "RUN_INVALID_INPUT",
      details: { path: "limits" }
    });
  }
  return Object.freeze({
    timeoutMs: parseRunLimit(limits, "timeoutMs"),
    cpuMs: parseRunLimit(limits, "cpuMs"),
    subRequests: parseRunLimit(limits, "subRequests"),
    maxSourceBytes: parseRunLimit(limits, "maxSourceBytes"),
    maxLogBytes: parseRunLimit(limits, "maxLogBytes"),
    maxHostFunctionCalls: parseRunLimit(limits, "maxHostFunctionCalls"),
    maxConcurrentHostFunctionCalls: parseRunLimit(
      limits,
      "maxConcurrentHostFunctionCalls"
    )
  });
}
