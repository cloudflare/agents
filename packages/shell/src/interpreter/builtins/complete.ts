/**
 * complete - Set and display programmable completion specifications
 *
 * Usage:
 *   complete                        - List all completion specs
 *   complete -p                     - Print all completion specs in reusable format
 *   complete -p cmd                 - Print completion spec for specific command
 *   complete -W 'word1 word2' cmd   - Set word list completion for cmd
 *   complete -F func cmd            - Set function completion for cmd
 *   complete -r cmd                 - Remove completion spec for cmd
 *   complete -r                     - Remove all completion specs
 *   complete -D ...                 - Set default completion (for commands with no specific spec)
 *   complete -o opt cmd             - Set completion options (nospace, filenames, default, etc.)
 */

import type { ExecResult } from "../../types";
import { failure, result, success } from "../helpers/result";
import type { CompletionSpec, InterpreterContext } from "../types";

// Valid completion options for -o flag
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

export function handleComplete(
  ctx: InterpreterContext,
  args: string[]
): ExecResult {
  // Initialize completionSpecs if not present
  if (!ctx.state.completionSpecs) {
    ctx.state.completionSpecs = new Map();
  }

  // Parse options
  let printMode = false;
  let removeMode = false;
  let isDefault = false;
  let wordlist: string | undefined;
  let funcName: string | undefined;
  let commandStr: string | undefined;
  const options: string[] = [];
  const actions: string[] = [];
  const commands: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === "-p") {
      printMode = true;
    } else if (arg === "-r") {
      removeMode = true;
    } else if (arg === "-D") {
      isDefault = true;
    } else if (arg === "-W") {
      // Word list
      i++;
      if (i >= args.length) {
        return failure("complete: -W: option requires an argument\n", 2);
      }
      wordlist = args[i];
    } else if (arg === "-F") {
      // Function name
      i++;
      if (i >= args.length) {
        return failure("complete: -F: option requires an argument\n", 2);
      }
      funcName = args[i];
      // Check if function exists - but bash doesn't actually validate this
      // According to test "complete with nonexistent function", bash returns 0 (BUG)
      // We'll match bash's buggy behavior for compatibility
    } else if (arg === "-o") {
      // Completion option
      i++;
      if (i >= args.length) {
        return failure("complete: -o: option requires an argument\n", 2);
      }
      const opt = args[i];
      if (!VALID_OPTIONS.includes(opt)) {
        return failure(`complete: ${opt}: invalid option name\n`, 2);
      }
      options.push(opt);
    } else if (arg === "-A") {
      // Action
      i++;
      if (i >= args.length) {
        return failure("complete: -A: option requires an argument\n", 2);
      }
      actions.push(args[i]);
    } else if (arg === "-C") {
      // Command to run for completion
      i++;
      if (i >= args.length) {
        return failure("complete: -C: option requires an argument\n", 2);
      }
      commandStr = args[i];
    } else if (arg === "-G") {
      // Glob pattern
      i++;
      if (i >= args.length) {
        return failure("complete: -G: option requires an argument\n", 2);
      }
      // Skip for now - -G is not fully implemented
    } else if (arg === "-P") {
      // Prefix
      i++;
      if (i >= args.length) {
        return failure("complete: -P: option requires an argument\n", 2);
      }
      // Skip for now
    } else if (arg === "-S") {
      // Suffix
      i++;
      if (i >= args.length) {
        return failure("complete: -S: option requires an argument\n", 2);
      }
      // Skip for now
    } else if (arg === "-X") {
      // Filter pattern
      i++;
      if (i >= args.length) {
        return failure("complete: -X: option requires an argument\n", 2);
      }
      // Skip for now
    } else if (arg === "--") {
      // End of options
      commands.push(...args.slice(i + 1));
      break;
    } else if (!arg.startsWith("-")) {
      commands.push(arg);
    }
  }

  // Handle remove mode (-r)
  if (removeMode) {
    if (commands.length === 0) {
      // Remove all completion specs
      ctx.state.completionSpecs.clear();
      return success("");
    }
    // Remove specific completion specs
    for (const cmd of commands) {
      ctx.state.completionSpecs.delete(cmd);
    }
    return success("");
  }

  // Handle print mode (-p)
  if (printMode) {
    if (commands.length === 0) {
      // Print all completion specs
      return printCompletionSpecs(ctx);
    }
    // Print specific completion specs
    return printCompletionSpecs(ctx, commands);
  }

  // If no options provided and no commands, just print all specs
  if (
    args.length === 0 ||
    (commands.length === 0 &&
      !wordlist &&
      !funcName &&
      !commandStr &&
      options.length === 0 &&
      actions.length === 0 &&
      !isDefault)
  ) {
    return printCompletionSpecs(ctx);
  }

  // Check for usage errors
  // -F requires a command name (unless -D is specified)
  if (funcName && commands.length === 0 && !isDefault) {
    return failure("complete: -F: option requires a command name\n", 2);
  }

  // If we have a command but no action/wordlist/function, bash allows it (BUG behavior)
  // See test "complete with no action" - bash returns 0 even though it's useless

  // Set completion specs for commands
  if (isDefault) {
    // Set default completion
    const spec: CompletionSpec = {
      isDefault: true
    };
    if (wordlist !== undefined) spec.wordlist = wordlist;
    if (funcName !== undefined) spec.function = funcName;
    if (commandStr !== undefined) spec.command = commandStr;
    if (options.length > 0) spec.options = options;
    if (actions.length > 0) spec.actions = actions;
    ctx.state.completionSpecs.set("__default__", spec);
    return success("");
  }

  for (const cmd of commands) {
    const spec: CompletionSpec = Object.create(null);
    if (wordlist !== undefined) spec.wordlist = wordlist;
    if (funcName !== undefined) spec.function = funcName;
    if (commandStr !== undefined) spec.command = commandStr;
    if (options.length > 0) spec.options = options;
    if (actions.length > 0) spec.actions = actions;
    ctx.state.completionSpecs.set(cmd, spec);
  }

  return success("");
}

/**
 * Print completion specs in reusable format
 */
function printCompletionSpecs(
  ctx: InterpreterContext,
  commands?: string[]
): ExecResult {
  const specs = ctx.state.completionSpecs;
  if (!specs || specs.size === 0) {
    if (commands && commands.length > 0) {
      // Requested specific commands but no specs exist
      let stderr = "";
      for (const cmd of commands) {
        stderr += `complete: ${cmd}: no completion specification\n`;
      }
      return result("", stderr, 1);
    }
    return success("");
  }

  const output: string[] = [];
  const targetCommands = commands || Array.from(specs.keys());

  for (const cmd of targetCommands) {
    if (cmd === "__default__") continue; // Skip internal default key when listing all

    const spec = specs.get(cmd);
    if (!spec) {
      if (commands) {
        // Specifically requested this command but it doesn't exist
        return result(
          output.join("\n") + (output.length > 0 ? "\n" : ""),
          `complete: ${cmd}: no completion specification\n`,
          1
        );
      }
      continue;
    }

    let line = "complete";

    // Add options
    if (spec.options) {
      for (const opt of spec.options) {
        line += ` -o ${opt}`;
      }
    }

    // Add actions
    if (spec.actions) {
      for (const action of spec.actions) {
        line += ` -A ${action}`;
      }
    }

    // Add wordlist
    if (spec.wordlist !== undefined) {
      // Quote the wordlist if it contains spaces
      if (spec.wordlist.includes(" ") || spec.wordlist.includes("'")) {
        line += ` -W '${spec.wordlist}'`;
      } else {
        line += ` -W ${spec.wordlist}`;
      }
    }

    // Add function
    if (spec.function !== undefined) {
      line += ` -F ${spec.function}`;
    }

    // Add default flag
    if (spec.isDefault) {
      line += " -D";
    }

    // Add command name
    line += ` ${cmd}`;

    output.push(line);
  }

  if (output.length === 0) {
    return success("");
  }

  return success(`${output.join("\n")}\n`);
}
