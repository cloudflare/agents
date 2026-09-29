export interface DemoArguments {
  baseUrl: string;
  prompt: string;
}

const DEFAULT_ORIGIN = "http://localhost:8787";
const DEFAULT_PROMPT = "How should we make a production migration safer?";

export function parseDemoArguments(
  input: string[],
  environmentOrigin?: string
): DemoArguments {
  const args = input[0] === "--" ? input.slice(1) : [...input];
  const originIndex = args.indexOf("--origin");
  let configuredOrigin = environmentOrigin;

  if (originIndex >= 0) {
    const [, origin] = args.splice(originIndex, 2);
    if (!origin) throw new Error("--origin requires a URL.");
    configuredOrigin = origin;
  }

  return {
    baseUrl: (configuredOrigin ?? DEFAULT_ORIGIN).replace(/\/$/, ""),
    prompt: args.join(" ") || DEFAULT_PROMPT
  };
}
