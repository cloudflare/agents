/**
 * A scripted Workers AI binding: answers chat completions in OpenAI's
 * streaming format, derived from the transcript alone, so a run replayed
 * after an eviction gets the same answer.
 *
 * - `fail` answers with a 400.
 * - `hold` calls the `hold` hook first, which a test uses to gate the run.
 * - anything else is echoed back as `echo: <prompt>`.
 *
 * OpenCode's restart notice is not a prompt: the script answers the user
 * message before it, as a model continuing the turn would.
 *
 * OpenCode's title requests (the ones without tools) answer `title`.
 */
export type ScriptedAI = {
  readonly binding: Ai;
  /** Models the binding was called with, in order. */
  readonly calls: string[];
};

function sse(text: string): Response {
  return new Response(chunks(text), {
    headers: { "content-type": "text/event-stream" }
  });
}

function chunks(text: string): string {
  const events = [
    { choices: [{ index: 0, delta: { role: "assistant", content: text } }] },
    {
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
    }
  ];
  return [...events.map((event) => JSON.stringify(event)), "[DONE]"]
    .map((data) => `data: ${data}\n\n`)
    .join("");
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part: unknown) =>
      typeof part === "object" &&
      part !== null &&
      "text" in part &&
      typeof part.text === "string"
        ? part.text
        : ""
    )
    .join("");
}

/** OpenCode's note to the model when it resumes a turn after a restart. */
const RESTART_NOTICE = "The server restarted";

/** The last thing the user said, skipping OpenCode's restart notice. */
function lastUserText(input: Record<string, unknown>): string {
  const messages: unknown[] = Array.isArray(input.messages)
    ? input.messages
    : [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (
      typeof message === "object" &&
      message !== null &&
      "role" in message &&
      message.role === "user" &&
      "content" in message
    ) {
      const text = textOf(message.content);
      if (!text.startsWith(RESTART_NOTICE)) return text;
    }
  }
  return "";
}

export function scriptedAI(
  hold: (signal: AbortSignal | undefined) => Promise<void> = async () => {}
): ScriptedAI {
  const calls: string[] = [];
  const binding = {
    aiGatewayLogId: null,
    async run(
      model: string,
      input: Record<string, unknown>,
      options?: { signal?: AbortSignal }
    ) {
      calls.push(model);
      // OpenCode's title requests carry no tools; answer them at once.
      if (input.stream !== true || !Array.isArray(input.tools)) {
        if (input.stream === true) return sse("title");
        return Response.json({
          choices: [
            {
              index: 0,
              finish_reason: "stop",
              message: { role: "assistant", content: "title" }
            }
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
        });
      }
      const prompt = lastUserText(input);
      if (prompt === "fail") {
        return Response.json(
          { errors: [{ message: "scripted failure" }] },
          { status: 400 }
        );
      }
      if (prompt === "hold") await hold(options?.signal);
      return sse(`echo: ${prompt}`);
    }
  };
  // SAFETY: the fixture implements only `run`, the one method
  // agents/models/ai-sdk calls on the Workers AI path.
  return { binding: binding as unknown as Ai, calls };
}
