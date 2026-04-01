/**
 * Skills — on-demand document loading via tools.
 *
 * Skills are documents stored externally (R2, KV, etc.) that the LLM
 * can load on demand. Metadata (key + description) is injected into
 * the system prompt so the model always knows what's available.
 * Full content is loaded when the model calls `load_skill`.
 */

import { jsonSchema, type ToolSet } from "ai";

/**
 * A single skill entry.
 */
export interface SkillEntry {
	/** Skill key (what the LLM uses to request it) */
	key: string;
	/** Human-readable description shown in the system prompt */
	description?: string;
	/** Size in bytes (informational) */
	size?: number;
}

/**
 * Storage interface for skills.
 * Implement this to back skills with R2, KV, HTTP, etc.
 */
export interface SkillProvider {
	/** Return lightweight metadata for all skills. Rendered into the system prompt. */
	metadata(): Promise<SkillEntry[]>;
	/** Get a skill's full content by key. Called by the load_skill tool. */
	get(key: string): Promise<string | null>;
}

// ── R2 Skill Provider ──────────────────────────────────────────────

/**
 * SkillProvider backed by an R2 bucket.
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

	async metadata(): Promise<SkillEntry[]> {
		const entries: SkillEntry[] = [];
		let cursor: string | undefined;
		let truncated = true;
		while (truncated) {
			const listed = await this.bucket.list({ prefix: this.prefix, cursor });
			for (const obj of listed.objects) {
				entries.push({
					key: obj.key.slice(this.prefix.length),
					description: obj.customMetadata?.description,
					size: obj.size,
				});
			}
			truncated = listed.truncated;
			cursor = listed.truncated ? listed.cursor : undefined;
		}
		return entries;
	}

	async get(key: string): Promise<string | null> {
		const obj = await this.bucket.get(this.prefix + key);
		if (!obj) return null;
		return obj.text();
	}
}

// ── Skills Manager ─────────────────────────────────────────────────

/**
 * Manages skill providers — loads metadata, renders into system prompt,
 * and produces the `load_skill` tool.
 *
 * Multiple providers can be registered. Their metadata is concatenated
 * into a single skills section in the system prompt.
 */
export class SkillsManager {
	private providers: SkillProvider[] = [];
	private entries: SkillEntry[] = [];
	private providerByKey = new Map<string, SkillProvider>();
	private loaded = false;

	add(provider: SkillProvider): void {
		this.providers.push(provider);
	}

	hasProviders(): boolean {
		return this.providers.length > 0;
	}

	/** Load metadata from all skill providers. */
	async load(): Promise<void> {
		this.entries = [];
		this.providerByKey.clear();

		for (const provider of this.providers) {
			const meta = await provider.metadata();
			for (const entry of meta) {
				this.entries.push(entry);
				this.providerByKey.set(entry.key, provider);
			}
		}

		this.loaded = true;
	}

	/** Render skills metadata section for the system prompt. */
	renderSystemPrompt(): string {
		if (!this.loaded || this.entries.length === 0) return "";

		const sep = "═".repeat(46);
		const header = "SKILLS (use load_skill to load)";
		const body = this.entries
			.map((e) => `- ${e.key}${e.description ? `: ${e.description}` : ""}`)
			.join("\n");

		return `${sep}\n${header}\n${sep}\n${body}`;
	}

	/** Build the `load_skill` tool. */
	tools(): ToolSet {
		if (!this.loaded || this.entries.length === 0) return {};

		const providerByKey = this.providerByKey;

		return {
			load_skill: {
				description:
					"Load a skill document by key. " +
					"Available skills are listed in the system prompt under the SKILLS section.",
				inputSchema: jsonSchema({
					type: "object" as const,
					properties: {
						key: {
							type: "string" as const,
							description: "Skill key to load",
						},
					},
					required: ["key"],
				}),
				execute: async ({ key }: { key: string }) => {
					const provider = providerByKey.get(key);
					if (!provider) return `Not found: ${key}`;
					const content = await provider.get(key);
					return content ?? `Not found: ${key}`;
				},
			},
		};
	}
}
