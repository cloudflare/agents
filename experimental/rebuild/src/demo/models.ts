/**
 * Demo LanguageModels — each a complete, deterministic "intelligence" proving
 * the model seam is honest: swap ELIZA for the Savant mid-conversation and
 * the agent keeps its memory (the log), changes its mind (the model).
 *
 * tortoise() is a model DECORATOR — modularity applies within a seam too.
 */

import type {
  Json,
  LanguageModel,
  LanguageModelErrorKind,
  LanguageModelOutput,
  LanguageModelRequest,
  LanguageModelStreamChunk,
  Part
} from "../contract";

type Io = {
  onChunk?: (chunk: LanguageModelStreamChunk) => void;
  signal?: AbortSignal;
};

function speak(text: string, io: Io): LanguageModelOutput {
  for (const word of text.split(/(?<= )/)) {
    io.onChunk?.({ type: "text-delta", delta: word });
  }
  return {
    parts: [{ type: "text", text }],
    finish: "stop",
    usage: { outputTokens: text.length }
  };
}

function callTool(
  callId: string,
  name: string,
  input: Json,
  io: Io
): LanguageModelOutput {
  io.onChunk?.({ type: "tool-call", callId, name, input });
  return {
    parts: [{ type: "tool-call", callId, name, input }],
    finish: "tool-calls",
    usage: {}
  };
}

function lastUserText(req: LanguageModelRequest): string {
  for (let i = req.messages.length - 1; i >= 0; i--) {
    const m = req.messages[i];
    if (m.role !== "user") continue;
    const t = m.parts.find((p): p is Extract<Part, { type: "text" }> => p.type === "text");
    if (t !== undefined) return t.text;
  }
  return "";
}

function lastToolResult(req: LanguageModelRequest): Extract<Part, { type: "tool-result" }> | null {
  const last = req.messages[req.messages.length - 1];
  if (last === undefined || last.role !== "tool") return null;
  const r = last.parts.find(
    (p): p is Extract<Part, { type: "tool-result" }> => p.type === "tool-result"
  );
  return r ?? null;
}

const classify = (error: unknown): LanguageModelErrorKind =>
  String(error).includes("abort") ? "transient" : "fatal";

// ---------------------------------------------------------------------------
// ELIZA (1966) — pattern-matching Rogerian therapist. Never calls a tool.
// ---------------------------------------------------------------------------

const ELIZA_RULES: Array<[RegExp, (m: RegExpMatchArray) => string]> = [
  [/my name is (\w+)/i, (m) => `Nice to meet you, ${m[1]}. What brings you here today?`],
  [/i need (.*)/i, (m) => `Why do you need ${m[1]}?`],
  [/i am (.*)/i, (m) => `How long have you been ${m[1]}?`],
  [/i'?m (.*)/i, (m) => `How does being ${m[1]} make you feel?`],
  [/i feel (.*)/i, (m) => `Tell me more about feeling ${m[1]}.`],
  [/because (.*)/i, (m) => `Is that the real reason — ${m[1]}?`],
  [/(computer|machine|agent|model)/i, () => "Do computers worry you?"],
  [/(no\b|never)/i, () => "Why not?"],
  [/(yes\b|yeah)/i, () => "You seem quite certain."],
  [/(mother|father|family)/i, () => "Tell me more about your family."],
  [/\?$/, () => "What do you think?"],
];

export function eliza(): LanguageModel {
  return {
    async generate(req, io) {
      if (io.signal?.aborted) throw new Error("aborted");
      const text = lastUserText(req);
      for (const [pattern, respond] of ELIZA_RULES) {
        const m = text.match(pattern);
        if (m !== null) return speak(respond(m), io);
      }
      return speak("I see. Please, go on.", io);
    },
    classifyError: classify
  };
}

// ---------------------------------------------------------------------------
// Magic 8-Ball — twenty answers, chosen by the question itself (deterministic).
// ---------------------------------------------------------------------------

const EIGHT_BALL = [
  "It is certain.", "Without a doubt.", "You may rely on it.", "Yes — definitely.",
  "As I see it, yes.", "Most likely.", "Outlook good.", "Signs point to yes.",
  "Reply hazy, try again.", "Ask again later.", "Better not tell you now.",
  "Cannot predict now.", "Concentrate and ask again.", "Don't count on it.",
  "My reply is no.", "My sources say no.", "Outlook not so good.",
  "Very doubtful.", "The stars say no.", "Absolutely."
];

export function magic8Ball(): LanguageModel {
  return {
    async generate(req, io) {
      if (io.signal?.aborted) throw new Error("aborted");
      const text = lastUserText(req);
      let h = 0;
      for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) >>> 0;
      return speak(`🎱 ${EIGHT_BALL[h % EIGHT_BALL.length]}`, io);
    },
    classifyError: classify
  };
}

// ---------------------------------------------------------------------------
// The Savant — a rule-based model that ACTUALLY uses tools: arithmetic, dice,
// fortunes, and the oracle. Proves the full agentic machinery with no LLM.
// ---------------------------------------------------------------------------

export function savant(): LanguageModel {
  let counter = 0;
  return {
    async generate(req, io) {
      if (io.signal?.aborted) throw new Error("aborted");

      const result = lastToolResult(req);
      if (result !== null) {
        const value =
          typeof result.output === "string" ? result.output : JSON.stringify(result.output);
        if (result.isError === true) {
          return speak(`Hm — that did not go to plan: ${value}`, io);
        }
        return speak(`The answer is ${value}.`, io);
      }

      const text = lastUserText(req);
      const callId = `sv-${++counter}-${text.length}`;

      if (/what('| i)?s my name|who am i/i.test(text)) {
        for (const m of req.messages) {
          if (m.role !== "user") continue;
          for (const p of m.parts) {
            if (p.type !== "text") continue;
            const named = p.text.match(/my name is (\w+)/i);
            if (named !== null) return speak(`Your name is ${named[1]}.`, io);
          }
        }
        return speak("I have no memory of your name. (Perhaps my context is... limited.)", io);
      }
      if (/oracle|destiny|future|prophecy|fate/i.test(text)) {
        return callTool(callId, "demo/consult_oracle", { question: text }, io);
      }
      if (/dice|roll|\bd(4|6|8|10|12|20)\b/i.test(text)) {
        const sides = Number(text.match(/\bd(\d+)\b/i)?.[1] ?? 6);
        return callTool(callId, "demo/roll_dice", { sides }, io);
      }
      if (/fortune/i.test(text)) {
        return callTool(callId, "demo/fortune_cookie", {}, io);
      }
      const math = text.match(/[-\d.()\s]*\d[\d.()\s]*(?:[+\-*/][-\d.()\s]*\d[\d.()\s]*)+/);
      if (math !== null) {
        return callTool(callId, "demo/evaluate", { expression: math[0].trim() }, io);
      }
      return speak(
        "I am the Savant. I can do arithmetic, roll dice, open fortune cookies, or consult the oracle about your destiny.",
        io
      );
    },
    classifyError: classify
  };
}

// ---------------------------------------------------------------------------
// tortoise — wraps ANY model to make it slow (and abortable): demonstrates
// model decorators, and makes preemption/stall behavior visible.
// ---------------------------------------------------------------------------

export function tortoise(inner: LanguageModel, delayMs = 2500): LanguageModel {
  return {
    async generate(req, io) {
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, delayMs);
        (t as unknown as { unref?: () => void }).unref?.();
        io.signal?.addEventListener(
          "abort",
          () => {
            clearTimeout(t);
            reject(new Error("aborted"));
          },
          { once: true }
        );
      });
      return inner.generate(req, io);
    },
    classifyError: (e) => inner.classifyError(e)
  };
}
