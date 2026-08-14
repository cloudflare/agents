/**
 * DEMO MODULE — ToolProvider: one tool per durability shape.
 *
 * - demo/evaluate       readonly — replay-safe, never claimed
 * - demo/roll_dice      mutating — a genuine unrepeatable effect, ledgered
 * - demo/consult_oracle mutating + PENDING — the effect outlives the call;
 *                       a correlated settlement entry (the outside world)
 *                       resolves it later, waking the parked turn
 *
 * The provider never touches claim/settle: its whole durability story is
 * the EffectDeclaration on each descriptor.
 */

import type { Json, ToolProvider } from "../contract";

export function demoTools(opts: { random?: () => number } = {}): ToolProvider {
  const random = opts.random ?? Math.random;
  return {
    name: "demo",
    async catalog() {
      return [
        {
          name: "demo/evaluate",
          description: "Evaluate an arithmetic expression, e.g. (2+3)*4",
          input: {
            type: "object",
            properties: { expression: { type: "string" } },
            required: ["expression"]
          },
          effect: { effect: "readonly" }
        },
        {
          name: "demo/roll_dice",
          description: "Roll a die. A real effect: rolling twice is two rolls.",
          input: {
            type: "object",
            properties: { sides: { type: "number" } }
          },
          effect: { effect: "mutating", retry: "at-least-once" }
        },
        {
          name: "demo/consult_oracle",
          description: "Ask the oracle a question. The answer arrives from outside, later.",
          input: {
            type: "object",
            properties: { question: { type: "string" } },
            required: ["question"]
          },
          effect: { effect: "mutating", retry: "at-least-once" }
        }
      ];
    },
    async execute(call, deps) {
      switch (call.name) {
        case "demo/evaluate": {
          const { expression } = call.input as { expression: string };
          try {
            return { status: "completed", output: evaluate(expression) };
          } catch (error) {
            return {
              status: "failed",
              message: `cannot evaluate "${expression}": ${String(error)}`,
              retryable: false
            };
          }
        }
        case "demo/roll_dice": {
          const sides = (call.input as { sides?: number }).sides ?? 6;
          const n = 1 + Math.floor(random() * sides);
          return { status: "completed", output: `rolled a ${n} (d${sides})` as Json };
        }
        case "demo/consult_oracle":
          return { status: "pending", correlation: deps.correlation };
        default:
          return { status: "failed", message: `unknown tool ${call.name}`, retryable: false };
      }
    }
  };
}

/** Tiny recursive-descent arithmetic parser: + - * / and parentheses. */
export function evaluate(expression: string): number {
  const s = expression.replace(/\s+/g, "");
  let i = 0;
  const primary = (): number => {
    if (s[i] === "(") {
      i++;
      const v = addSub();
      if (s[i] !== ")") throw new Error("missing )");
      i++;
      return v;
    }
    if (s[i] === "-") {
      i++;
      return -primary();
    }
    const m = s.slice(i).match(/^\d+(\.\d+)?/);
    if (m === null) throw new Error(`unexpected "${s.slice(i, i + 8)}"`);
    i += m[0].length;
    return Number(m[0]);
  };
  const mulDiv = (): number => {
    let v = primary();
    while (s[i] === "*" || s[i] === "/") v = s[i++] === "*" ? v * primary() : v / primary();
    return v;
  };
  const addSub = (): number => {
    let v = mulDiv();
    while (s[i] === "+" || s[i] === "-") v = s[i++] === "+" ? v + mulDiv() : v - mulDiv();
    return v;
  };
  const v = addSub();
  if (i !== s.length) throw new Error(`trailing input "${s.slice(i)}"`);
  return v;
}
