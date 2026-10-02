import { accessHeaders } from "./access";
import { parseArgs, usage, UsageError } from "./args";
import { runTui } from "./app";

/** Runs `agents tui`; resolves with the exit code. */
export async function main(argv: readonly string[]): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(usage);
    return 0;
  }
  let args;
  try {
    args = parseArgs(argv, process.env);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    console.error(`${error.message}\n\n${usage}`);
    return 2;
  }
  try {
    const access = await accessHeaders(args.url, args.headers);
    args = { ...args, headers: { ...args.headers, ...access } };
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
  await runTui(args);
  return 0;
}
