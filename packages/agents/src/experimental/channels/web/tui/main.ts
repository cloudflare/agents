import { accessHeaders, type AccessHeaders } from "./access";
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
  let access: AccessHeaders;
  try {
    access = await accessHeaders(args.url, args.headers);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
  const { headers } = args;
  await runTui(args, () => ({ ...headers, ...access() }));
  return 0;
}
