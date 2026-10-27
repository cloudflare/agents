import { parseStreamingJson, type ToolCall } from "@earendil-works/pi-ai";

type Arguments = ToolCall["arguments"];

const VALID_ESCAPES = new Set(['"', "\\", "/", "b", "f", "n", "r", "t", "u"]);
const HEX = /^[0-9a-fA-F]$/;

/**
 * A streamed tool call's arguments, parsed as their text arrives.
 *
 * pi-ai's `parseStreamingJson` re-parses the whole text on every delta: a
 * `JSON.parse` that throws, a character-by-character repair, a second throwing
 * `JSON.parse`, then a partial parse. Over a long argument, such as a file
 * passed to a write tool, that is quadratic in time and garbage.
 *
 * This keeps the lexer state (open containers, whether the text ends inside a
 * string or an escape) across deltas, so each delta scans only its own
 * characters. A snapshot closes the open string and containers and hands the
 * result to the native `JSON.parse`, which still reads the whole text but
 * throws nothing and builds no intermediate strings in JavaScript. When the text ends mid-token (a key, a
 * number, `tru`) the closed text does not parse, and the previous snapshot
 * stands until the next delta. Unlike `parseStreamingJson`, a partial string
 * keeps its trailing whitespace. Text that needs pi-ai's repairs (raw control
 * characters or invalid escapes inside a string) goes back to
 * `parseStreamingJson` for the rest of the call.
 */
export class PartialArguments {
  #text = "";
  #snapshot: Arguments = {};
  #needsRepair = false;
  readonly #containers: ("}" | "]")[] = [];
  #inString = false;
  /** Characters since the last backslash in a string, while in an escape. */
  #escape: string | undefined;

  get text(): string {
    return this.#text;
  }

  /** Append `delta` and return the arguments parsed so far. */
  push(delta: string): Arguments {
    this.#text += delta;
    if (!this.#needsRepair) this.#scan(delta);
    if (this.#needsRepair) {
      this.#snapshot = parseStreamingJson(this.#text);
      return this.#snapshot;
    }
    const parsed = this.#parseClosed();
    if (parsed !== undefined) this.#snapshot = parsed;
    return this.#snapshot;
  }

  #scan(delta: string): void {
    for (const char of delta) {
      if (this.#escape !== undefined) {
        this.#escape += char;
        if (this.#escape.length === 1) {
          if (!VALID_ESCAPES.has(char)) {
            this.#needsRepair = true;
            return;
          }
          if (char !== "u") this.#escape = undefined;
        } else {
          if (!HEX.test(char)) {
            this.#needsRepair = true;
            return;
          }
          if (this.#escape.length === 5) this.#escape = undefined;
        }
        continue;
      }
      if (this.#inString) {
        if (char === '"') this.#inString = false;
        else if (char === "\\") this.#escape = "";
        else if (char < " ") {
          this.#needsRepair = true;
          return;
        }
        continue;
      }
      if (char === '"') this.#inString = true;
      else if (char === "{") this.#containers.push("}");
      else if (char === "[") this.#containers.push("]");
      else if (char === "}" || char === "]") this.#containers.pop();
    }
  }

  #parseClosed(): Arguments | undefined {
    let text = this.#text;
    if (this.#inString) {
      // Drop an unfinished escape, then end the string.
      if (this.#escape !== undefined) {
        text = text.slice(0, text.length - this.#escape.length - 1);
      }
      text += '"';
    } else {
      text = text.trimEnd();
      if (text.endsWith(",")) text = text.slice(0, -1);
    }
    for (let i = this.#containers.length - 1; i >= 0; i--) {
      text += this.#containers[i];
    }
    if (text.trim() === "") return {};
    try {
      const value: unknown = JSON.parse(text);
      return typeof value === "object" &&
        value !== null &&
        !Array.isArray(value)
        ? (value as Arguments)
        : undefined;
    } catch {
      return undefined;
    }
  }
}
