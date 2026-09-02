/**
 * Skill Provider — on-demand keyed document collections.
 *
 * Extends ContextProvider with `load()` for on-demand content fetching
 * and a keyed `set()` for writing individual entries.
 *
 * Duck-typed: if a provider has a `load` method, it's a SkillProvider.
 */

import type { ContextProvider } from "./blocks";
import type {
  HistoryBatchReadOptions,
  SessionMessage
} from "../sessions/types";

type SkillMessage = SessionMessage;

/** The slice of `Session` the skill helpers need. */
export interface SkillSession {
  historyBatches(
    options?: HistoryBatchReadOptions
  ): AsyncGenerator<SessionMessage[], void, undefined>;
  updateMessage(message: SessionMessage): Promise<SessionMessage | null>;
}

/**
 * Storage interface for skill collections.
 *
 * - `get()` returns metadata listing (rendered into system prompt)
 * - `load(key)` fetches full content (via load_context tool)
 * - `set(key, content, description?)` writes an entry (via set_context tool)
 */
export interface SkillProvider extends ContextProvider {
  load(key: string): Promise<string | null>;
  set?(key: string, content: string, description?: string): Promise<void>;
}

/**
 * Check if a provider is a SkillProvider (has a `load` method).
 */
export function isSkillProvider(provider: unknown): provider is SkillProvider {
  return (
    typeof provider === "object" &&
    provider !== null &&
    "load" in provider &&
    typeof (provider as SkillProvider).load === "function"
  );
}

// ── R2 Skill Provider ──────────────────────────────────────────────

/**
 * SkillProvider backed by an R2 bucket.
 *
 * - `get()` returns a metadata listing of all skills (key + description)
 * - `load(key)` fetches a skill's full content
 * - `set(key, content, description?)` writes a skill
 *
 * Descriptions are pulled from R2 custom metadata (`description` key).
 * If a prefix is provided, it is prepended on storage operations and
 * stripped from keys in metadata. `keys`, when provided, is matched against
 * these prefix-relative keys.
 *
 * @example
 * ```ts
 * const skills = new R2SkillProvider(env.SKILLS_BUCKET, {
 *   prefix: "skills/",
 *   keys: ["code-review", "debugging"]
 * });
 * ```
 */
export class R2SkillProvider implements SkillProvider {
  private bucket: R2Bucket;
  private prefix: string;
  private keys: Set<string> | null;

  constructor(
    bucket: R2Bucket,
    options?: { prefix?: string; keys?: string[] }
  ) {
    this.bucket = bucket;
    this.prefix = options?.prefix ?? "";
    this.keys = options?.keys?.length ? new Set(options.keys) : null;
  }

  async get(): Promise<string | null> {
    const entries: string[] = [];
    let cursor: string | undefined;
    let truncated = true;
    while (truncated) {
      const listed = await this.bucket.list({
        prefix: this.prefix,
        cursor,
        include: ["customMetadata"]
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any);
      for (const obj of listed.objects) {
        const key = obj.key.slice(this.prefix.length);
        if (!this.allowsKey(key)) continue;
        const desc = obj.customMetadata?.description;
        entries.push(`- ${key}${desc ? `: ${desc}` : ""}`);
      }
      truncated = listed.truncated;
      cursor = listed.truncated ? listed.cursor : undefined;
    }
    return entries.length > 0 ? entries.join("\n") : null;
  }

  async load(key: string): Promise<string | null> {
    if (!this.allowsKey(key)) return null;
    const obj = await this.bucket.get(this.prefix + key);
    if (!obj) return null;
    return obj.text();
  }

  async set(key: string, content: string, description?: string): Promise<void> {
    await this.bucket.put(this.prefix + key, content, {
      customMetadata: description ? { description } : undefined
    });
  }

  private allowsKey(key: string): boolean {
    return this.keys === null || this.keys.has(key);
  }
}

// ── Session-backed skill state ─────────────────────────────────────

/**
 * Which skills a transcript left loaded, from the `load_context` /
 * `unload_context` tool calls it recorded. Reads assistant rows in bounded
 * batches with pointers left alone, so a long transcript never materializes.
 */
export async function restoreLoadedSkills(
  context: {
    hasSkillCapableConfigs(): boolean;
    restoreLoadedSkills(ids: Iterable<string>): void;
  },
  session: SkillSession
): Promise<void> {
  if (!context.hasSkillCapableConfigs()) return;
  const loaded = new Set<string>();
  for await (const batch of session.historyBatches({
    reconstruct: "pointer"
  })) {
    for (const message of batch) {
      if (message.role !== "assistant") continue;
      for (const part of message.parts) {
        const input = skillInput(part.input);
        if (!input || part.state !== "output-available") continue;
        const id = `${input.label}:${input.key}`;
        if (part.toolName === "load_context") {
          if (
            typeof part.output === "string" &&
            part.output.startsWith("[skill unloaded:")
          ) {
            loaded.delete(id);
          } else {
            loaded.add(id);
          }
        } else if (part.toolName === "unload_context") {
          loaded.delete(id);
        }
      }
    }
  }
  context.restoreLoadedSkills(loaded);
}

/**
 * Replace a loaded skill's stored tool result with a short marker so the
 * model stops seeing its content after an unload.
 */
export async function reclaimLoadedSkill(
  session: SkillSession,
  label: string,
  key: string
): Promise<void> {
  const batches: SkillMessage[][] = [];
  for await (const batch of session.historyBatches({
    reconstruct: "pointer"
  })) {
    batches.push(batch);
  }
  for (let i = batches.length - 1; i >= 0; i--) {
    const batch = batches[i];
    for (let j = batch.length - 1; j >= 0; j--) {
      const message = batch[j];
      if (message.role !== "assistant") continue;
      let changed = false;
      const parts = message.parts.map((part) => {
        const input = skillInput(part.input);
        if (
          part.toolName === "load_context" &&
          part.state === "output-available" &&
          input?.label === label &&
          input.key === key
        ) {
          changed = true;
          return { ...part, output: `[skill unloaded: ${key}]` };
        }
        return part;
      });
      if (changed) {
        await session.updateMessage({ ...message, parts });
        return;
      }
    }
  }
}

function skillInput(input: unknown): { label: string; key: string } | null {
  if (typeof input !== "object" || input === null) return null;
  if (!("label" in input) || !("key" in input)) return null;
  const { label, key } = input as { label: unknown; key: unknown };
  return typeof label === "string" && typeof key === "string"
    ? { label, key }
    : null;
}
