/**
 * DEMO MODULE — LanguageModel, the wacky one.
 *
 * ELIZA (Weizenbaum, 1966): a pattern-matching Rogerian therapist wearing
 * the LanguageModel interface. The point: the seam does not assume an LLM —
 * it assumes "request in, streamed output out, classify your own errors."
 * A sixty-year-old chatbot drops in beside Workers AI and the AI SDK as a
 * peer, with the same harness, admission, channels and durability around it.
 */

import type {
  LanguageModel,
  LanguageModelMessage,
  LanguageModelOutput
} from "../../contract.js";

const RULES: Array<[RegExp, (m: RegExpMatchArray) => string]> = [
  [
    /my name is (\w+)/i,
    (m) => `Nice to meet you, ${m[1]}. What brings you here today?`
  ],
  [/i need (.*)/i, (m) => `Why do you need ${m[1]}?`],
  [/i am (.*)/i, (m) => `How long have you been ${m[1]}?`],
  [/i'?m (.*)/i, (m) => `How does being ${m[1]} make you feel?`],
  [/i feel (.*)/i, (m) => `Tell me more about feeling ${m[1]}.`],
  [/because (.*)/i, (m) => `Is that the real reason — ${m[1]}?`],
  [/(computer|machine|agent|model)/i, () => "Do computers worry you?"],
  [/\b(no|never)\b/i, () => "Why not?"],
  [/\b(yes|yeah)\b/i, () => "You seem quite certain."],
  [/(mother|father|family)/i, () => "Tell me more about your family."],
  [/\?$/, () => "What do you think?"]
];

export function eliza(): LanguageModel {
  return {
    async generate(req, io): Promise<LanguageModelOutput> {
      if (io.signal?.aborted) throw new Error("aborted");
      const text = latestUserText(req.messages);
      const rule = RULES.find(([pattern]) => pattern.test(text));
      const reply = rule
        ? rule[1](text.match(rule[0]) as RegExpMatchArray)
        : "I see. Please, go on.";
      for (const word of reply.split(/(?<= )/)) {
        io.onChunk?.({ type: "text-delta", delta: word });
      }
      return {
        parts: [{ type: "text", text: reply }],
        finish: "stop",
        usage: { outputTokens: reply.length }
      };
    },
    classifyError: () => "fatal"
  };
}

function latestUserText(messages: readonly LanguageModelMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role !== "user") continue;
    const part = messages[i].parts.find((p) => p.type === "text");
    if (part !== undefined && part.type === "text") return part.text;
  }
  return "";
}
