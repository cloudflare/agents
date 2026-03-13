/**
 * Quote an argument so it is interpreted as a single literal shell word.
 */
function shellQuoteArg(arg: string): string {
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

/**
 * Join argv-style tokens into a shell-safe command string.
 */
export function shellJoinArgs(args: readonly string[]): string {
  return args.map(shellQuoteArg).join(" ");
}
