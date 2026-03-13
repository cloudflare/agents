/**
 * compopt - Modify completion options
 *
 * Usage:
 *   compopt [-o option] [+o option] [name ...]
 *   compopt -D [-o option] [+o option]
 *   compopt -E [-o option] [+o option]
 *
 * Modifies completion options for the specified commands (names) or the
 * currently executing completion when no names are provided.
 *
 * Options:
 *   -o option  Enable completion option
 *   +o option  Disable completion option
 *   -D         Apply to default completion
 *   -E         Apply to empty-line completion
 *
 * Valid completion options:
 *   bashdefault, default, dirnames, filenames, noquote, nosort, nospace, plusdirs
 *
 * Returns:
 *   0 on success
 *   1 if not in a completion function and no command name is given
 *   2 if an invalid option is specified
 */

import type { ExecResult } from "../../types";
import { failure, success } from "../helpers/result";
import type { InterpreterContext } from "../types";

// Valid completion options for -o/+o flags
const VALID_OPTIONS = [
  "bashdefault",
  "default",
  "dirnames",
  "filenames",
  "noquote",
  "nosort",
  "nospace",
  "plusdirs"
];

export function handleCompopt(
  ctx: InterpreterContext,
  args: string[]
): ExecResult {
  // Initialize completionSpecs if not present
  if (!ctx.state.completionSpecs) {
    ctx.state.completionSpecs = new Map();
  }

  // Parse options
  let isDefault = false;
  let isEmptyLine = false;
  const enableOptions: string[] = [];
  const disableOptions: string[] = [];
  const commands: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === "-D") {
      isDefault = true;
    } else if (arg === "-E") {
      isEmptyLine = true;
    } else if (arg === "-o") {
      // Enable completion option
      i++;
      if (i >= args.length) {
        return failure("compopt: -o: option requires an argument\n", 2);
      }
      const opt = args[i];
      if (!VALID_OPTIONS.includes(opt)) {
        return failure(`compopt: ${opt}: invalid option name\n`, 2);
      }
      enableOptions.push(opt);
    } else if (arg === "+o") {
      // Disable completion option
      i++;
      if (i >= args.length) {
        return failure("compopt: +o: option requires an argument\n", 2);
      }
      const opt = args[i];
      if (!VALID_OPTIONS.includes(opt)) {
        return failure(`compopt: ${opt}: invalid option name\n`, 2);
      }
      disableOptions.push(opt);
    } else if (arg === "--") {
      // End of options
      commands.push(...args.slice(i + 1));
      break;
    } else if (!arg.startsWith("-") && !arg.startsWith("+")) {
      commands.push(arg);
    }
  }

  // If -D flag is set, modify default completion
  if (isDefault) {
    const spec = ctx.state.completionSpecs.get("__default__") ?? {
      isDefault: true
    };
    const currentOptions = new Set(spec.options ?? []);

    // Enable options
    for (const opt of enableOptions) {
      currentOptions.add(opt);
    }

    // Disable options
    for (const opt of disableOptions) {
      currentOptions.delete(opt);
    }

    spec.options =
      currentOptions.size > 0 ? Array.from(currentOptions) : undefined;
    ctx.state.completionSpecs.set("__default__", spec);
    return success("");
  }

  // If -E flag is set, modify empty-line completion
  if (isEmptyLine) {
    // @banned-pattern-ignore: completion spec with known structure (options array)
    const spec = ctx.state.completionSpecs.get("__empty__") ?? {};
    const currentOptions = new Set(spec.options ?? []);

    // Enable options
    for (const opt of enableOptions) {
      currentOptions.add(opt);
    }

    // Disable options
    for (const opt of disableOptions) {
      currentOptions.delete(opt);
    }

    spec.options =
      currentOptions.size > 0 ? Array.from(currentOptions) : undefined;
    ctx.state.completionSpecs.set("__empty__", spec);
    return success("");
  }

  // If command names are provided, modify their completion specs
  if (commands.length > 0) {
    for (const cmd of commands) {
      // @banned-pattern-ignore: completion spec with known structure (options array)
      const spec = ctx.state.completionSpecs.get(cmd) ?? {};
      const currentOptions = new Set(spec.options ?? []);

      // Enable options
      for (const opt of enableOptions) {
        currentOptions.add(opt);
      }

      // Disable options
      for (const opt of disableOptions) {
        currentOptions.delete(opt);
      }

      spec.options =
        currentOptions.size > 0 ? Array.from(currentOptions) : undefined;
      ctx.state.completionSpecs.set(cmd, spec);
    }
    return success("");
  }

  // No command name and not -D/-E: we need to be in a completion function
  // In bash, compopt modifies the current completion context when called
  // from within a completion function. Since we don't have a completion
  // context indicator, we fail if no command name is given.
  // This matches bash behavior: "compopt: not currently executing completion function"
  return failure("compopt: not currently executing completion function\n", 1);
}
