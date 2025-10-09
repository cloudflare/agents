import type { ModelRequest, ChatMessage } from "./types";

// llm/providers.ts
export interface Provider {
  invoke(
    req: ModelRequest,
    opts: { signal?: AbortSignal }
  ): Promise<ModelResult>;
  stream(
    req: ModelRequest,
    onDelta: (chunk: string) => void
  ): Promise<ModelResult>;
}

export type ModelResult = {
  message: ChatMessage; // assistant message (may include tool_calls)
  usage?: { promptTokens: number; completionTokens: number; costUsd?: number };
};

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

function parseModel(m: string): string {
  // Accept "openai:gpt-4o-mini" style or raw "gpt-4o-mini"
  const idx = m.indexOf(":");
  return idx >= 0 ? m.slice(idx + 1) : m;
}

function toOA(req: ModelRequest): {
  model: string;
  messages: OAChatMsg[];
  temperature?: number;
  max_tokens?: number;
  stop?: string[];
} {
  const msgs: OAChatMsg[] = [];
  if (req.systemPrompt)
    msgs.push({ role: "system", content: req.systemPrompt });

  for (const m of req.messages) {
    if (m.role === "assistant" && "tool_calls" in m && m.tool_calls?.length) {
      msgs.push({
        role: "assistant",
        content: "",
        tool_calls: m.tool_calls!.map((tc, i) => ({
          id: tc.id ?? `call_${i}`,
          type: "function",
          function: {
            name: tc.name,
            // keep string if already a string; otherwise JSON stringify
            arguments:
              typeof tc.args === "string"
                ? (tc.args as string)
                : JSON.stringify(tc.args ?? {})
          }
        }))
      });
    } else if (m.role === "tool") {
      msgs.push({
        role: "tool",
        content: m.content,
        tool_call_id: (m as any).tool_call_id
      });
    } else {
      msgs.push({ role: m.role as any, content: (m as any).content ?? "" });
    }
  }

  return {
    model: parseModel(req.model),
    messages: msgs,
    temperature: req.temperature,
    max_tokens: req.maxTokens,
    stop: req.stop
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

    async stream(req, onDelta) {
      return { message: { role: "assistant", content: "Hello, world!" } };
    }
  };
}
export function makeAnthropic(_baseUrl: string, _apiKey: string): Provider {
  /* SSE parse */
  return {
    invoke: async (_req, _opts) => {
      return { message: { role: "assistant", content: "Hello, world!" } };
    },
    stream: async (_req, _onDelta) => {
      return { message: { role: "assistant", content: "Hello, world!" } };
    }
  };
}
export function makeWorkersAI(_ai: unknown): Provider {
  /* @cloudflare/ai or fetch */
  return {
    invoke: async (_req, _opts) => {
      return { message: { role: "assistant", content: "Hello, world!" } };
    },
    stream: async (_req, _onDelta) => {
      return { message: { role: "assistant", content: "Hello, world!" } };
    }
  };
}
