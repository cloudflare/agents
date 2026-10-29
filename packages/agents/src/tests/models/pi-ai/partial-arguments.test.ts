import { parseStreamingJson } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { createAI } from "../../../models/pi-ai";
import { PartialArguments } from "../../../models/pi-ai/wires/partial-arguments";
import {
  WEATHER_TOOL_PARAMETERS,
  asAi,
  fakeBinding,
  sseResponse
} from "./helpers";

const DOCUMENTS = [
  '{"city": "London"}',
  '{"path":"/workspace/a.txt","content":"line one\\nline \\"two\\"\\n\\tend \\u00e9\\\\"}',
  '{"n": 12.5, "ok": true, "none": null, "list": [1, "two", {"three": [3]}], "nested": {"a": {"b": "c"}}}',
  '{ "spaced" : [ 1 , 2 ] , "s" : "x" }',
  '{"emoji":"\\ud83d\\ude00 🙂"}'
];

/**
 * `partial-json`, under pi-ai's `parseStreamingJson`, trims trailing
 * whitespace off a partial string; `PartialArguments` keeps it. Compare
 * without it.
 */
function trimStrings(value: unknown): unknown {
  if (typeof value === "string") return value.trimEnd();
  if (Array.isArray(value)) return value.map(trimStrings);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, trimStrings(item)])
    );
  }
  return value;
}

/** Splits `text` into chunks of the given sizes, cycling. */
function chunks(text: string, sizes: number[]): string[] {
  const out: string[] = [];
  let at = 0;
  for (let i = 0; at < text.length; i++) {
    const size = sizes[i % sizes.length];
    out.push(text.slice(at, at + size));
    at += size;
  }
  return out;
}

describe("PartialArguments", () => {
  it.each(DOCUMENTS)("ends at JSON.parse of the whole text: %s", (doc) => {
    for (const sizes of [[1], [2, 3], [7], [doc.length]]) {
      const parser = new PartialArguments();
      let last: Record<string, unknown> = {};
      for (const chunk of chunks(doc, sizes)) last = parser.push(chunk);
      expect(last).toEqual(JSON.parse(doc));
      expect(parser.text).toBe(doc);
    }
  });

  it.each(DOCUMENTS)(
    "each snapshot matches parseStreamingJson or the one before: %s",
    (doc) => {
      const parser = new PartialArguments();
      let previous: Record<string, unknown> = {};
      for (let i = 1; i <= doc.length; i++) {
        const snapshot = parser.push(doc[i - 1]);
        const expected = parseStreamingJson(doc.slice(0, i));
        if (JSON.stringify(snapshot) !== JSON.stringify(previous)) {
          expect(trimStrings(snapshot)).toEqual(trimStrings(expected));
        }
        previous = snapshot;
      }
    }
  );

  it("shows a string value growing on every delta", () => {
    const parser = new PartialArguments();
    parser.push('{"content":"');
    const seen: unknown[] = [];
    for (const char of "hello world") {
      seen.push(parser.push(char).content);
    }
    expect(seen).toEqual([
      "h",
      "he",
      "hel",
      "hell",
      "hello",
      "hello ",
      "hello w",
      "hello wo",
      "hello wor",
      "hello worl",
      "hello world"
    ]);
  });

  it("drops an escape split across deltas until it completes", () => {
    const parser = new PartialArguments();
    expect(parser.push('{"a":"x\\')).toEqual({ a: "x" });
    expect(parser.push("u00")).toEqual({ a: "x" });
    expect(parser.push("e9")).toEqual({ a: "xé" });
    expect(parser.push('"}')).toEqual({ a: "xé" });
  });

  it("hands text that needs repair to parseStreamingJson", () => {
    const raw = '{"a":"one\ntwo","b":"c:\\d"}';
    const parser = new PartialArguments();
    let last: Record<string, unknown> = {};
    for (let i = 1; i <= raw.length; i++) {
      last = parser.push(raw[i - 1]);
      expect(last).toEqual(parseStreamingJson(raw.slice(0, i)));
    }
    expect(last).toEqual({ a: "one\ntwo", b: "c:\\d" });
  });
});

describe("pi-ai: chat completions tool arguments", () => {
  it("streams partial arguments and ends with the full call", async () => {
    const args = '{"city": "London", "units": "metric"}';
    const toolChunk = (fragment: string, first: boolean) =>
      JSON.stringify({
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  ...(first
                    ? {
                        id: "call-1",
                        type: "function",
                        function: { name: "getWeather", arguments: fragment }
                      }
                    : { function: { arguments: fragment } })
                }
              ]
            },
            index: 0
          }
        ],
        id: "c",
        object: "chat.completion.chunk"
      });
    const events = chunks(args, [1]).map((fragment, i) =>
      toolChunk(fragment, i === 0)
    );
    events.push(
      JSON.stringify({
        choices: [{ delta: {}, finish_reason: "tool_calls", index: 0 }],
        id: "c",
        object: "chat.completion.chunk"
      }),
      "[DONE]"
    );
    const binding = fakeBinding(() => sseResponse(events));
    const ai = createAI({ binding: asAi(binding) });
    const stream = ai.streamSimple(ai("@cf/zai-org/glm-4.7-flash"), {
      messages: [{ content: "Weather?", role: "user", timestamp: 1 }],
      tools: [
        {
          description: "Get weather",
          name: "getWeather",
          parameters: WEATHER_TOOL_PARAMETERS as never
        }
      ]
    });
    // `partial` is the live message, so read it as each event arrives.
    const partialCities: unknown[] = [];
    for await (const event of stream) {
      if (event.type !== "toolcall_delta") continue;
      const block = event.partial.content[event.contentIndex];
      if (block.type === "toolCall") partialCities.push(block.arguments.city);
    }
    const message = await stream.result();

    expect(partialCities).toContain("Lon");
    expect(partialCities.at(-1)).toBe("London");
    expect(message.content.at(-1)).toEqual({
      arguments: { city: "London", units: "metric" },
      id: "call-1",
      name: "getWeather",
      type: "toolCall"
    });
  });
});
