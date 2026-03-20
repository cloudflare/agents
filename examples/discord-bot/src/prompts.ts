import type { Mode } from "./types";
import { DEFAULT_MODE } from "./types";

const BASE_PROMPT = `You are a helpful team assistant in a Discord server.
Format your responses using markdown for readability.
If you don't know something, say so honestly rather than guessing.`;

const MODE_SUFFIX: Record<Mode, string> = {
  concise:
    "Keep responses to 1-2 sentences maximum. No preamble, no filler — get straight to the point. Use bullet points only if absolutely necessary.",
  detailed:
    "Provide thorough, well-structured answers. Use headings, bullet points, and examples where helpful. Explain your reasoning, not just your conclusions.",
  creative:
    "Use a playful, conversational tone. Lean on analogies, metaphors, and emoji to make your answers memorable. Surprise the user — don't be boring."
};

const SUMMARIZE_PROMPT =
  "Summarize the following conversation concisely in 3-5 sentences. " +
  "Capture the key topics discussed, any decisions made, and action items identified. " +
  "Do not editorialize or add your own opinions.";

export function getSystemPrompt(mode: Mode): string {
  return `${BASE_PROMPT}\n\n${MODE_SUFFIX[mode] ?? MODE_SUFFIX[DEFAULT_MODE]}`;
}

export function getSummarizePrompt(): string {
  return SUMMARIZE_PROMPT;
}
