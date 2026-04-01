/**
 * Session Skills Example
 *
 * Demonstrates the Catalog Provider with:
 * - Skills stored in R2, loaded on demand via `get_catalog` tool
 * - Session memory with context blocks (soul, memory)
 * - Callable methods to manage skills from the UI sidebar
 */

import {
	Agent,
	callable,
	routeAgentRequest,
	type StreamingResponse,
} from "agents";
import { R2SkillProvider, Session } from "agents/experimental/memory/session";
import {
	createCompactFunction,
	truncateOlderMessages,
} from "agents/experimental/memory/utils";
import type { UIMessage } from "ai";
import {
	convertToModelMessages,
	generateText,
	stepCountIs,
	streamText,
} from "ai";
import { createWorkersAI } from "workers-ai-provider";

export interface Skill {
	key: string;
	description?: string;
	size?: number;
}

export class SkillsAgent extends Agent<Env> {
	session = Session.create(this)
		.withContext("soul", {
			initialContent: [
				"You are a helpful assistant with access to skills.",
				"When a user asks you to do something, check the SKILLS section for a relevant skill and use load_skill to load it.",
				"Use update_context to save important facts to memory.",
			].join("\n"),
			readonly: true,
		})
		.withContext("memory", {
			description: "Learned facts — save important things here",
			maxTokens: 1100,
		})
		.withSkills(
			new R2SkillProvider(this.env.SKILLS_BUCKET, { prefix: "skills/" }),
		)
		.onCompaction(
			createCompactFunction({
				summarize: (prompt) =>
					generateText({
						model: createWorkersAI({ binding: this.env.AI })(
							"@cf/zai-org/glm-4.7-flash",
						),
						prompt,
					}).then((r) => r.text),
				tailTokenBudget: 150,
				minTailMessages: 1,
			}),
		)
		.compactAfter(1000)
		.withCachedPrompt();

	private getAI() {
		return createWorkersAI({ binding: this.env.AI })(
			"@cf/moonshotai/kimi-k2.5",
			{ sessionAffinity: this.sessionAffinity },
		);
	}

	// ── Chat ────────────────────────────────────────────────────────

	@callable({ streaming: true })
	async chat(
		stream: StreamingResponse,
		message: string,
		messageId?: string,
	): Promise<void> {
		await this.session.appendMessage({
			id: messageId ?? `user-${crypto.randomUUID()}`,
			role: "user",
			parts: [{ type: "text", text: message }],
		});

		const history = this.session.getHistory();
		const truncated = truncateOlderMessages(history);

		const result = streamText({
			model: this.getAI(),
			system: await this.session.freezeSystemPrompt(),
			messages: await convertToModelMessages(truncated),
			tools: await this.session.tools(),
			stopWhen: stepCountIs(5),
		});

		for await (const chunk of result.textStream) {
			stream.send({ type: "text-delta", text: chunk });
		}

		const parts: UIMessage["parts"] = [];
		const steps = await result.steps;

		for (const step of steps) {
			for (const tc of step.toolCalls) {
				const tr = step.toolResults.find((r) => r.toolCallId === tc.toolCallId);
				parts.push({
					type: "dynamic-tool",
					toolName: tc.toolName,
					toolCallId: tc.toolCallId,
					state: tr ? "output-available" : "input-available",
					input: tc.input,
					...(tr ? { output: tr.output } : {}),
				} as unknown as UIMessage["parts"][number]);
			}
		}

		const text = await result.text;
		if (text) {
			parts.push({ type: "text", text });
		}

		const assistantMsg: UIMessage = {
			id: `assistant-${crypto.randomUUID()}`,
			role: "assistant",
			parts,
		};

		await this.session.appendMessage(assistantMsg);
		stream.end({ message: assistantMsg });
	}

	// ── Skills management (called from sidebar) ─────────────────────

	@callable()
	async listSkills(): Promise<Skill[]> {
		const provider = new R2SkillProvider(this.env.SKILLS_BUCKET, {
			prefix: "skills/",
		});
		return provider.metadata();
	}

	@callable()
	async getSkill(key: string): Promise<string | null> {
		const provider = new R2SkillProvider(this.env.SKILLS_BUCKET, {
			prefix: "skills/",
		});
		return provider.get(key);
	}

	@callable()
	async saveSkill(
		key: string,
		content: string,
		description?: string,
	): Promise<{ success: boolean }> {
		const fullKey = `skills/${key}`;
		await this.env.SKILLS_BUCKET.put(fullKey, content, {
			customMetadata: description ? { description } : undefined,
		});
		return { success: true };
	}

	@callable()
	async deleteSkill(key: string): Promise<{ success: boolean }> {
		await this.env.SKILLS_BUCKET.delete(`skills/${key}`);
		return { success: true };
	}

	// ── History ─────────────────────────────────────────────────────

	@callable()
	getMessages(): UIMessage[] {
		return this.session.getHistory();
	}

	@callable()
	clearMessages(): void {
		this.session.clearMessages();
	}
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		return (
			(await routeAgentRequest(request, env)) ||
			new Response("Not found", { status: 404 })
		);
	},
};
