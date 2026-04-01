/**
 * Skill Provider — on-demand keyed document collections.
 *
 * Extends ContextProvider with `load()` for on-demand content fetching
 * and a keyed `set()` for writing individual entries.
 *
 * Duck-typed: if a provider has a `load` method, it's a SkillProvider.
 */

import type { ContextProvider } from "./context";

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
export function isSkillProvider(
	provider: unknown
): provider is SkillProvider {
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
 * stripped from keys in metadata.
 *
 * @example
 * ```ts
 * const skills = new R2SkillProvider(env.SKILLS_BUCKET, { prefix: "skills/" });
 * ```
 */
export class R2SkillProvider implements SkillProvider {
	private bucket: R2Bucket;
	private prefix: string;

	constructor(bucket: R2Bucket, options?: { prefix?: string }) {
		this.bucket = bucket;
		this.prefix = options?.prefix ?? "";
	}

	async get(): Promise<string | null> {
		const entries: string[] = [];
		let cursor: string | undefined;
		let truncated = true;
		while (truncated) {
			const listed = await this.bucket.list({
				prefix: this.prefix,
				cursor,
			});
			for (const obj of listed.objects) {
				const key = obj.key.slice(this.prefix.length);
				const desc = obj.customMetadata?.description;
				entries.push(`- ${key}${desc ? `: ${desc}` : ""}`);
			}
			truncated = listed.truncated;
			cursor = listed.truncated ? listed.cursor : undefined;
		}
		return entries.length > 0 ? entries.join("\n") : null;
	}

	async load(key: string): Promise<string | null> {
		const obj = await this.bucket.get(this.prefix + key);
		if (!obj) return null;
		return obj.text();
	}

	async set(
		key: string,
		content: string,
		description?: string
	): Promise<void> {
		await this.bucket.put(this.prefix + key, content, {
			customMetadata: description ? { description } : undefined,
		});
	}
}
