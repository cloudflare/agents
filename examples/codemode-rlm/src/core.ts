export const INPUT_CHUNK_CHARS = 60_000;
export const MAX_INPUT_CHARS = 20_000_000;
export const MAX_CONTEXT_OUTPUT_CHARS = 8_192;
export const MAX_KERNEL_VALUE_CHARS = 128_000;
export const MAX_ANSWER_CHARS = 100_000;
export const MAX_HARNESS_BYTES = 800_000;

export type InputSource = "task" | "material";
export type HarnessKind = "prompt" | "memory" | "skill" | "subagent";
export type HarnessAction = "create" | "update" | "delete";

export type HarnessEntry = {
  id: string;
  kind: HarnessKind;
  title: string;
  content: string;
  path: string;
  reference: Record<string, unknown>;
  arguments: Record<string, unknown>;
  metadata: Record<string, unknown>;
  source: "refiner" | "user";
  createdAt: number;
  updatedAt: number;
  version: number;
};

export type HarnessEdit = {
  action: HarnessAction;
  kind: HarnessKind;
  id?: string;
  title?: string;
  content?: string;
  path?: string;
  reference: Record<string, unknown>;
  arguments: Record<string, unknown>;
  metadata: Record<string, unknown>;
  reason: string;
};

export type HarnessRefinement = {
  id: string;
  revision: number;
  trigger: string;
  evidence: string;
  expectedOutcome: string;
  changes: string[];
  createdAt: number;
};

export type HarnessState = {
  schema: 1;
  revision: number;
  entries: Record<HarnessKind, Record<string, HarnessEntry>>;
  refinements: HarnessRefinement[];
};

export type HarnessApplyRequest = {
  expectedRevision: number;
  trigger: string;
  evidence: string;
  expectedOutcome: string;
  edits: HarnessEdit[];
};

export type HarnessApplyResult = {
  state: HarnessState;
  before: Record<string, HarnessEntry | null>;
  after: Record<string, HarnessEntry | null>;
  changes: string[];
};

const HARNESS_KINDS = new Set<HarnessKind>([
  "prompt",
  "memory",
  "skill",
  "subagent"
]);
const HARNESS_ACTIONS = new Set<HarnessAction>(["create", "update", "delete"]);

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

export function requireString(
  value: unknown,
  name: string,
  options: { min?: number; max?: number } = {}
): string {
  if (typeof value !== "string") {
    throw new Error(`${name} must be a string`);
  }
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

/**
 * Build a compact deterministic identifier from an unambiguous string tuple.
 * JSON tuple encoding avoids collisions such as ["a\0b", "c"] versus
 * ["a", "b\0c"], which delimiter-joined inputs cannot distinguish.
 */
export async function stableId(
  prefix: string,
  ...parts: string[]
): Promise<string> {
  const encoded = new TextEncoder().encode(
    JSON.stringify(["codemode-rlm-id-v1", ...parts])
  );
  const digest = await crypto.subtle.digest("SHA-256", encoded);
  const hash = Array.from(new Uint8Array(digest))
    .slice(0, 16)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `${prefix}_${hash}`;
}

export function optionalString(
  value: unknown,
  name: string,
  maximum: number
): string | undefined {
  if (value === undefined || value === null) return undefined;
  return requireString(value, name, { max: maximum });
}

export function truncateText(value: string, maximum: number): string {
  if (value.length <= maximum) return value;
  const omitted = value.length - maximum;
  const marker = `\n...[${omitted} characters omitted]`;
  if (marker.length >= maximum) return value.slice(0, maximum);
  return `${value.slice(0, maximum - marker.length)}${marker}`;
}

export function truncateUnknown(value: unknown, maximum: number): unknown {
  if (typeof value === "string") return truncateText(value, maximum);
  try {
    const encoded = JSON.stringify(value, null, 2);
    if (encoded === undefined || encoded.length <= maximum) return value;
    return truncateText(encoded, maximum);
  } catch {
    return truncateText("[unserializable result]", maximum);
  }
}

export function slug(value: string, fallback = "entry"): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);
  return normalized || fallback;
}

export function splitInput(value: string): string[] {
  if (value.length === 0) return [];
  const chunks: string[] = [];
  for (let index = 0; index < value.length; index += INPUT_CHUNK_CHARS) {
    chunks.push(value.slice(index, index + INPUT_CHUNK_CHARS));
  }
  return chunks;
}

export function emptyHarnessState(): HarnessState {
  return {
    schema: 1,
    revision: 0,
    entries: {
      prompt: {},
      memory: {},
      skill: {},
      subagent: {}
    },
    refinements: []
  };
}

export function normalizeHarnessApply(value: unknown): HarnessApplyRequest {
  if (!isRecord(value))
    throw new Error("harness.apply input must be an object");

  const expectedRevision = boundedInteger(
    value.expectedRevision,
    -1,
    -1,
    Number.MAX_SAFE_INTEGER
  );
  if (expectedRevision < 0) {
    throw new Error("expectedRevision must be a non-negative integer");
  }

  const trigger = requireString(value.trigger, "trigger", {
    min: 1,
    max: 1_000
  });
  const evidence = requireString(value.evidence, "evidence", {
    min: 1,
    max: 8_000
  });
  const expectedOutcome = requireString(
    value.expectedOutcome,
    "expectedOutcome",
    { min: 1, max: 4_000 }
  );
  if (!Array.isArray(value.edits) || value.edits.length === 0) {
    throw new Error("edits must be a non-empty array");
  }
  if (value.edits.length > 12) {
    throw new Error("one refinement may contain at most 12 edits");
  }

  const edits = value.edits.map((raw, index): HarnessEdit => {
    if (!isRecord(raw)) throw new Error(`edits[${index}] must be an object`);
    if (!HARNESS_ACTIONS.has(raw.action as HarnessAction)) {
      throw new Error(`edits[${index}].action is invalid`);
    }
    if (!HARNESS_KINDS.has(raw.kind as HarnessKind)) {
      throw new Error(`edits[${index}].kind is invalid`);
    }
    const action = raw.action as HarnessAction;
    const kind = raw.kind as HarnessKind;
    const id = optionalString(raw.id, `edits[${index}].id`, 80);
    if (action !== "create" && !id) {
      throw new Error(`edits[${index}].id is required for ${action}`);
    }

    const title = optionalString(raw.title, `edits[${index}].title`, 240);
    const content = optionalString(
      raw.content,
      `edits[${index}].content`,
      12_000
    );
    if (action !== "delete" && (!title || !content)) {
      throw new Error(
        `edits[${index}] requires non-empty title and content for ${action}`
      );
    }
    const path = optionalString(raw.path, `edits[${index}].path`, 240);
    const reference = isRecord(raw.reference) ? raw.reference : {};
    const args = isRecord(raw.arguments) ? raw.arguments : {};
    const metadata = isRecord(raw.metadata) ? raw.metadata : {};
    const reason = requireString(raw.reason, `edits[${index}].reason`, {
      min: 1,
      max: 1_000
    });

    if (kind === "skill" && action !== "delete") {
      if (
        reference.type !== "codemode-snippet" ||
        typeof reference.name !== "string" ||
        reference.name.length === 0
      ) {
        throw new Error(
          `edits[${index}] skill entries must reference a developer-promoted ` +
            `Code Mode snippet with {type: "codemode-snippet", name: "..."}`
        );
      }
    }

    return {
      action,
      kind,
      id,
      title,
      content,
      path,
      reference,
      arguments: args,
      metadata,
      reason
    };
  });

  return { expectedRevision, trigger, evidence, expectedOutcome, edits };
}

function cloneHarnessState(state: HarnessState): HarnessState {
  return JSON.parse(JSON.stringify(state)) as HarnessState;
}

function cloneEntry(entry: HarnessEntry | undefined): HarnessEntry | null {
  return entry ? (JSON.parse(JSON.stringify(entry)) as HarnessEntry) : null;
}

export function applyHarnessEdits(
  current: HarnessState,
  request: HarnessApplyRequest,
  now: number,
  refinementId: string
): HarnessApplyResult {
  if (current.revision !== request.expectedRevision) {
    throw new Error(
      `harness revision conflict: expected ${request.expectedRevision}, ` +
        `current is ${current.revision}; inspect the harness and re-plan`
    );
  }

  const next = cloneHarnessState(current);
  const before: Record<string, HarnessEntry | null> = {};
  const after: Record<string, HarnessEntry | null> = {};
  const changes: string[] = [];

  for (const edit of request.edits) {
    const records = next.entries[edit.kind];
    let id = edit.id;
    if (edit.action === "create") {
      const base = slug(id || edit.title || edit.kind, edit.kind);
      id = base;
      let suffix = 2;
      while (Object.hasOwn(records, id)) {
        id = `${base}_${suffix}`;
        suffix += 1;
      }
    }
    if (!id) throw new Error("normalized harness edit is missing an id");
    const key = `${edit.kind}:${id}`;
    const existing = Object.hasOwn(records, id) ? records[id] : undefined;
    before[key] = cloneEntry(existing);

    if (edit.action === "delete") {
      if (!existing)
        throw new Error(`cannot delete missing harness entry ${key}`);
      delete records[id];
      after[key] = null;
      changes.push(`deleted ${key}: ${edit.reason}`);
      continue;
    }

    if (edit.action === "update" && !existing) {
      throw new Error(`cannot update missing harness entry ${key}`);
    }

    const entry: HarnessEntry = {
      id,
      kind: edit.kind,
      title: edit.title ?? existing?.title ?? id,
      content: edit.content ?? existing?.content ?? "",
      path: edit.path ?? existing?.path ?? "general",
      reference: edit.reference,
      arguments: edit.arguments,
      metadata: edit.metadata,
      source: "refiner",
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      version: (existing?.version ?? 0) + 1
    };
    records[id] = entry;
    after[key] = cloneEntry(entry);
    changes.push(`${edit.action}d ${key}: ${edit.reason}`);
  }

  next.revision = current.revision + 1;
  next.refinements.push({
    id: refinementId,
    revision: next.revision,
    trigger: request.trigger,
    evidence: request.evidence,
    expectedOutcome: request.expectedOutcome,
    changes,
    createdAt: now
  });
  next.refinements = next.refinements.slice(-100);

  if (JSON.stringify(next).length > MAX_HARNESS_BYTES) {
    throw new Error(
      `refinement would exceed the ${MAX_HARNESS_BYTES}-character harness limit`
    );
  }
  return { state: next, before, after, changes };
}

export function rollbackHarness(
  current: HarnessState,
  target: HarnessState,
  targetRevision: number,
  evidence: string,
  now: number,
  refinementId: string
): HarnessState {
  const next: HarnessState = {
    schema: 1,
    revision: current.revision + 1,
    entries: cloneHarnessState(target).entries,
    refinements: [
      ...current.refinements,
      {
        id: refinementId,
        revision: current.revision + 1,
        trigger: `rollback to revision ${targetRevision}`,
        evidence,
        expectedOutcome: `restore the harness behavior captured at revision ${targetRevision}`,
        changes: [`restored entry snapshot from revision ${targetRevision}`],
        createdAt: now
      }
    ].slice(-100)
  };
  if (JSON.stringify(next).length > MAX_HARNESS_BYTES) {
    throw new Error(
      `rollback would exceed the ${MAX_HARNESS_BYTES}-character harness limit`
    );
  }
  return next;
}

export function buildHarnessOverview(
  state: HarnessState,
  options: {
    entriesPerKind?: number;
    refinements?: number;
    contentChars?: number;
  } = {}
): string {
  const entriesPerKind = options.entriesPerKind ?? 6;
  const refinementLimit = options.refinements ?? 5;
  const contentChars = options.contentChars ?? 180;
  const lines = [
    "# Continual Harness State",
    `Revision: ${state.revision}`,
    "The immutable base prompt is not represented here. These entries are supplemental.",
    "Full entries are available programmatically through the harness connector."
  ];

  for (const kind of ["prompt", "memory", "skill", "subagent"] as const) {
    const entries = Object.values(state.entries[kind]);
    lines.push("", `${kind}: ${entries.length}`);
    for (const entry of entries.slice(0, entriesPerKind)) {
      const summary = truncateText(
        entry.content.replace(/\s+/g, " "),
        contentChars
      );
      lines.push(
        `- [${entry.id}] ${entry.title} (${entry.path}, v${entry.version}): ${summary}`
      );
    }
    if (entries.length > entriesPerKind) {
      lines.push(`- +${entries.length - entriesPerKind} more`);
    }
  }

  const recent = state.refinements.slice(-refinementLimit);
  lines.push("", `refinements: ${state.refinements.length}`);
  for (const item of recent) {
    lines.push(`- [${item.id}] r${item.revision} ${item.trigger}`);
  }
  return lines.join("\n");
}

export function inputSource(value: unknown): InputSource {
  if (value !== "task" && value !== "material") {
    throw new Error('source must be "task" or "material"');
  }
  return value;
}
