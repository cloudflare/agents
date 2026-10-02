import { parseArgs, usage, UsageError } from "./args";
import { runTui } from "./app";

/** Runs `agents tui`; resolves with the exit code. */
export async function main(argv: readonly string[]): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(usage);
    return 0;
  }
  try {
    await runTui(parseArgs(argv, process.env));
    return 0;
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    console.error(`${error.message}\n\n${usage}`);
    return 2;
  }
}
