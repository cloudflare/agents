import type { ChatMessage, ModelRequest } from "../types";
import { type Provider, parseModel } from ".";

type OAChatMsg =
  | {
      role: "system" | "user" | "assistant" | "tool";
      content: string;
      name?: string;
      tool_call_id?: string;
    }
  | {
      role: "assistant";
      content?: string;
      tool_calls?: Array<{
        id: string;
        type: "function";
        function: { name: string; arguments: string };
      }>;
    };

function toOA(req: ModelRequest) {
  const msgs: OAChatMsg[] = [];
  if (req.systemPrompt)
    msgs.push({ role: "system", content: req.systemPrompt });

  for (const m of req.messages) {
    if (m.role === "tool") {
      msgs.push({
        role: "tool",
        content: m.content ?? "",
        tool_call_id: m.tool_call_id
      });
    } else if (
      m.role === "assistant" &&
      "tool_calls" in m &&
      m.tool_calls?.length
    ) {
      msgs.push({
        role: "assistant",
        content: "", // TODO: check whether we can skip this when we have tool_calls
        tool_calls: m.tool_calls.map(({ id, name, args }) => ({
          id,
          type: "function",
          function: {
            name,
            arguments:
              typeof args === "string" ? args : JSON.stringify(args ?? {})
          }
        }))
      });
    } else if ("content" in m) {
      msgs.push({ role: m.role, content: m.content ?? "" });
    }
  }

  const tools = (req.toolDefs ?? []).map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description ?? undefined,
      parameters: t.parameters ?? {
        type: "object",
        properties: {},
        additionalProperties: true
      }
    }
  }));

  return {
    model: parseModel(req.model),
    messages: msgs,
    temperature: req.temperature,
    max_tokens: req.maxTokens,
    stop: req.stop,
    tools,
    tool_choice: req.toolChoice ?? "auto"
  };
}

function fromOA(choice: any): ChatMessage {
  const msg = choice?.message ?? {};
  if (msg?.tool_calls?.length) {
    return {
      role: "assistant",
      tool_calls: msg.tool_calls.map((tc: any) => ({
        id: tc.id,
        name: tc.function?.name,
        // Try to parse, but fall back to raw string to avoid hard failures
        args: (() => {
          try {
            return JSON.parse(tc.function?.arguments ?? "{}");
          } catch {
            return tc.function?.arguments ?? "{}";
          }
        })()
      }))
    };
  }
  return { role: "assistant", content: msg?.content ?? "" };
}

// TODO: implement one of these
export function makeOpenAI(
  apiKey: string,
  baseUrl = "https://api.openai.com/v1"
): Provider {
  const headers = {
    "content-type": "application/json",
    authorization: `Bearer ${apiKey}`
  };

  return {
    async invoke(req, { signal }) {
      const body = toOA(req);
      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify({ ...body, stream: false }),
        signal
      });
      if (!res.ok) {
        const errTxt = await res.text().catch(() => "");
        throw new Error(`OpenAI error ${res.status}: ${errTxt}`);
      }
      const json = (await res.json()) as {
        choices: Array<{ message: OAChatMsg }>;
        usage: { prompt_tokens: number; completion_tokens: number };
      };
      const message = fromOA(json.choices?.[0]);
      const usage = json.usage
        ? {
            promptTokens: json.usage.prompt_tokens,
            completionTokens: json.usage.completion_tokens
          }
        : undefined;
      return { message, usage };
    },

    // don't care about streaming for now
    async stream(_req, _onDelta) {
      throw new Error("Streaming not implemented");
    }
  };
}
