export const INPUT_CHUNK_CHARS = 60_000;
export const MAX_INPUT_CHARS = 20_000_000;
export const MAX_CONTEXT_OUTPUT_CHARS = 8_192;
export const MAX_KERNEL_KEYS = 256;
export const MAX_KERNEL_VALUE_CHARS = 128_000;
export const MAX_ANSWER_CHARS = 100_000;
export const MAX_HARNESS_CHARS = 128_000;

export type InputSource = "task" | "material";
export type HarnessKind = "instruction" | "memory" | "delegate";
export type ModelReasoningEffort = "low" | "medium" | "high" | null;

export type ObservedRuntimeConfig = {
  model: string;
  reasoningEffort: ModelReasoningEffort;
  maxSteps: number;
  timeoutMs: number;
  maxDepth: number;
  maxRlmCalls: number;
};

type RuntimeConfigSource = {
  MODEL?: unknown;
  REASONING_EFFORT?: unknown;
  MAX_STEPS?: unknown;
  TURN_TIMEOUT_MS?: unknown;
  MAX_RLM_DEPTH?: unknown;
  MAX_RLM_CALLS?: unknown;
};

export type HarnessEntry = {
  id: string;
  kind: HarnessKind;
  content: string;
  updatedAt: number;
};

export type HarnessState = {
  schema: 2;
  revision: number;
  entries: HarnessEntry[];
  lastChange?: {
    reason: string;
    evidence: string;
    createdAt: number;
  };
};

export type HarnessUpdate = {
  expectedRevision: number;
  reason: string;
  evidence: string;
  upsert: Array<Omit<HarnessEntry, "updatedAt">>;
  remove: string[];
};

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function boundedInteger(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number
): number {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number.parseInt(value, 10)
        : Number.NaN;
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.trunc(parsed)));
}

export function modelReasoningEffort(
  value: unknown,
  fallback: ModelReasoningEffort = "low"
): ModelReasoningEffort {
  if (value === "none" || value === null) return null;
  return value === "low" || value === "medium" || value === "high"
    ? value
    : fallback;
}

/** The non-secret, effective configuration shared by the evaluation controls. */
export function observedRuntimeConfig(
  env: RuntimeConfigSource
): ObservedRuntimeConfig {
  return {
    model:
      typeof env.MODEL === "string" && env.MODEL
        ? env.MODEL
        : "@cf/moonshotai/kimi-k2.7-code",
    reasoningEffort: modelReasoningEffort(env.REASONING_EFFORT),
    maxSteps: boundedInteger(env.MAX_STEPS, 12, 2, 40),
    timeoutMs: boundedInteger(env.TURN_TIMEOUT_MS, 180_000, 10_000, 900_000),
    maxDepth: boundedInteger(env.MAX_RLM_DEPTH, 1, 0, 1),
    maxRlmCalls: boundedInteger(env.MAX_RLM_CALLS, 8, 0, 16)
  };
}

export function requireString(
  value: unknown,
  name: string,
  options: { min?: number; max?: number } = {}
): string {
  if (typeof value !== "string") throw new Error(`${name} must be a string`);
  const min = options.min ?? 0;
  const max = options.max ?? Number.POSITIVE_INFINITY;
  if (value.length < min) {
    throw new Error(`${name} must contain at least ${min} characters`);
  }
  if (value.length > max) {
    throw new Error(`${name} must contain at most ${max} characters`);
  }
  return value;
}

export function truncateText(value: string, maximum: number): string {
  if (value.length <= maximum) return value;
  const marker = "\n...[truncated]";
  if (marker.length >= maximum) return value.slice(0, maximum);
  return `${value.slice(0, maximum - marker.length)}${marker}`;
}

export function truncateUnknown(value: unknown, maximum: number): unknown {
  if (typeof value === "string") return truncateText(value, maximum);
  try {
    const encoded = JSON.stringify(value, null, 2);
    if (encoded === undefined) return "[undefined result]";
    if (encoded.length <= maximum) return JSON.parse(encoded) as unknown;
    return truncateText(encoded, maximum);
  } catch {
    return "[unserializable result]";
  }
}

/** Tuple encoding makes ids deterministic without delimiter collisions. */
export async function stableId(
  prefix: string,
  ...parts: string[]
): Promise<string> {
  const bytes = new TextEncoder().encode(
    JSON.stringify(["codemode-rlm-id-v1", ...parts])
  );
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hash = Array.from(new Uint8Array(digest).slice(0, 16), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
  return `${prefix}_${hash}`;
}

export function splitInput(value: string): string[] {
  const chunks: string[] = [];
  for (let index = 0; index < value.length; index += INPUT_CHUNK_CHARS) {
    chunks.push(value.slice(index, index + INPUT_CHUNK_CHARS));
  }
  return chunks;
}

export function inputSource(value: unknown): InputSource {
  if (value !== "task" && value !== "material") {
    throw new Error('source must be "task" or "material"');
  }
  return value;
}

export function emptyHarnessState(): HarnessState {
  return { schema: 2, revision: 0, entries: [] };
}

function harnessKind(value: unknown, name: string): HarnessKind {
  if (value !== "instruction" && value !== "memory" && value !== "delegate") {
    throw new Error(`${name} must be instruction, memory, or delegate`);
  }
  return value;
}

function entryId(value: unknown, name: string): string {
  const id = requireString(value, name, { min: 1, max: 80 });
  if (!/^[a-zA-Z0-9_.-]+$/.test(id)) {
    throw new Error(
      `${name} may contain only letters, digits, dot, dash, and underscore`
    );
  }
  return id;
}

export function normalizeHarnessUpdate(value: unknown): HarnessUpdate {
  if (!isRecord(value))
    throw new Error("harness.update input must be an object");
  const expectedRevision = boundedInteger(
    value.expectedRevision,
    -1,
    -1,
    Number.MAX_SAFE_INTEGER
  );
  if (expectedRevision < 0) {
    throw new Error("expectedRevision must be a non-negative integer");
  }
  const reason = requireString(value.reason, "reason", { min: 1, max: 1_000 });
  const evidence = requireString(value.evidence, "evidence", {
    min: 1,
    max: 8_000
  });
  const rawUpsert = value.upsert ?? [];
  const rawRemove = value.remove ?? [];
  if (!Array.isArray(rawUpsert) || !Array.isArray(rawRemove)) {
    throw new Error("upsert and remove must be arrays");
  }
  if (rawUpsert.length + rawRemove.length === 0) {
    throw new Error(
      "a harness update must upsert or remove at least one entry"
    );
  }
  if (rawUpsert.length + rawRemove.length > 12) {
    throw new Error("one harness update may change at most 12 entries");
  }
  const upsert = rawUpsert.map((raw, index) => {
    if (!isRecord(raw)) throw new Error(`upsert[${index}] must be an object`);
    return {
      id: entryId(raw.id, `upsert[${index}].id`),
      kind: harnessKind(raw.kind, `upsert[${index}].kind`),
      content: requireString(raw.content, `upsert[${index}].content`, {
        min: 1,
        max: 12_000
      })
    };
  });
  const remove = rawRemove.map((id, index) => entryId(id, `remove[${index}]`));
  if (
    new Set([...upsert.map((entry) => entry.id), ...remove]).size !==
    upsert.length + remove.length
  ) {
    throw new Error("a harness update may mention each id only once");
  }
  return { expectedRevision, reason, evidence, upsert, remove };
}

export function applyHarnessUpdate(
  current: HarnessState,
  update: HarnessUpdate,
  now = Date.now()
): HarnessState {
  if (current.revision !== update.expectedRevision) {
    throw new Error(
      `harness revision conflict: expected ${update.expectedRevision}, current is ${current.revision}`
    );
  }
  const entries = new Map(current.entries.map((entry) => [entry.id, entry]));
  for (const id of update.remove) {
    if (!entries.delete(id))
      throw new Error(`cannot remove missing harness entry ${id}`);
  }
  for (const entry of update.upsert)
    entries.set(entry.id, { ...entry, updatedAt: now });
  const next: HarnessState = {
    schema: 2,
    revision: current.revision + 1,
    entries: [...entries.values()].sort((left, right) =>
      left.id.localeCompare(right.id)
    ),
    lastChange: {
      reason: update.reason,
      evidence: update.evidence,
      createdAt: now
    }
  };
  if (JSON.stringify(next).length > MAX_HARNESS_CHARS) {
    throw new Error(`harness update exceeds ${MAX_HARNESS_CHARS} characters`);
  }
  return next;
}

export function buildHarnessOverview(state: HarnessState): string {
  const lines = [
    "# Continual harness",
    `Revision: ${state.revision}`,
    "These entries supplement the immutable base prompt."
  ];
  for (const kind of ["instruction", "memory", "delegate"] as const) {
    const entries = state.entries.filter((entry) => entry.kind === kind);
    lines.push("", `${kind}: ${entries.length}`);
    for (const entry of entries.slice(0, 8)) {
      lines.push(
        `- [${entry.id}] ${truncateText(
          entry.content.replace(/\s+/g, " "),
          240
        )}`
      );
    }
  }
  return lines.join("\n");
}
