/**
 * Demo ToolProvider: four tools with four durability shapes.
 * - demo/evaluate       readonly  — replay-safe arithmetic (own tiny parser)
 * - demo/fortune_cookie readonly  — deterministic fortunes
 * - demo/roll_dice      mutating  — a genuine effect (randomness!), ledgered
 * - demo/consult_oracle mutating+PENDING — parks the turn until the outside
 *                       world answers (/prophesy in the REPL)
 */

import type { Json, ToolProvider } from "../contract";

// -- tiny arithmetic parser (+ - * / parens), no eval -----------------------

export function evaluate(expression: string): number {
  let i = 0;
  const s = expression.replace(/\s+/g, "");
  const peek = () => s[i];
  const parsePrimary = (): number => {
    if (peek() === "(") {
      i++;
      const v = parseAddSub();
      if (peek() !== ")") throw new Error("missing )");
      i++;
      return v;
    }
    if (peek() === "-") {
      i++;
      return -parsePrimary();
    }
    const m = s.slice(i).match(/^\d+(\.\d+)?/);
    if (m === null) throw new Error(`unexpected "${s.slice(i, i + 8)}"`);
    i += m[0].length;
    return Number(m[0]);
  };
  const parseMulDiv = (): number => {
    let v = parsePrimary();
    while (peek() === "*" || peek() === "/") {
      const op = s[i++];
      const rhs = parsePrimary();
      v = op === "*" ? v * rhs : v / rhs;
    }
    return v;
  };
  const parseAddSub = (): number => {
    let v = parseMulDiv();
    while (peek() === "+" || peek() === "-") {
      const op = s[i++];
      const rhs = parseMulDiv();
      v = op === "+" ? v + rhs : v - rhs;
    }
    return v;
  };
  const v = parseAddSub();
  if (i !== s.length) throw new Error(`trailing input "${s.slice(i)}"`);
  return v;
}

const FORTUNES = [
  "A modular architecture is its own reward.",
  "The log remembers what the context forgets.",
  "You will soon replace a subsystem with a smaller one.",
  "Beware of shared mutable state dressed as a friend.",
  "An unsettled claim weighs on the conscience. Reconcile.",
  "Your next deploy will be boring. This is the highest praise."
];

export interface DemoToolOptions {
  /** Injectable randomness so tests stay deterministic. */
  readonly random?: () => number;
}

export function demoTools(opts: DemoToolOptions = {}): ToolProvider {
  const random = opts.random ?? Math.random;
  return {
    name: "demo",
    async catalog() {
      return [
        {
          name: "demo/evaluate",
          description: "Evaluate an arithmetic expression",
          input: { type: "object" },
          effect: { effect: "readonly" }
        },
        {
          name: "demo/fortune_cookie",
          description: "Crack open a fortune cookie",
          input: { type: "object" },
          effect: { effect: "readonly" }
        },
        {
          name: "demo/roll_dice",
          description: "Roll a die (a real, unrepeatable effect)",
          input: { type: "object" },
          effect: { effect: "mutating", retry: "at-least-once" }
        },
        {
          name: "demo/consult_oracle",
          description: "Ask the oracle; the answer arrives from outside",
          input: { type: "object" },
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
        case "demo/fortune_cookie": {
          const n = Math.floor(random() * FORTUNES.length);
          return { status: "completed", output: `🥠 ${FORTUNES[n]}` };
        }
        case "demo/roll_dice": {
          const { sides } = call.input as { sides?: number };
          const n = 1 + Math.floor(random() * (sides ?? 6));
          return { status: "completed", output: `🎲 rolled a ${n} (d${sides ?? 6})` as Json };
        }
        case "demo/consult_oracle": {
          // The effect outlives the call: a correlated settlement entry
          // (the /prophesy command, playing the outside world) resolves it.
          return { status: "pending", correlation: deps.correlation };
        }
        default:
          return { status: "failed", message: `unknown tool ${call.name}`, retryable: false };
      }
    }
  };
}
