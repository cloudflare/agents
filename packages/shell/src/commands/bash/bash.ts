import { mergeToNullPrototype } from "../../helpers/env";
import type { Command, CommandContext, ExecResult } from "../../types";
import { hasHelpFlag, showHelp } from "../help";

const bashHelp = {
  name: "bash",
  summary: "execute shell commands or scripts",
  usage: "bash [OPTIONS] [SCRIPT_FILE] [ARGUMENTS...]",
  options: [
    "-c COMMAND  execute COMMAND string",
    "    --help  display this help and exit"
  ],
  notes: [
    "Without -c, reads and executes commands from SCRIPT_FILE.",
    "Arguments are passed as $1, $2, etc. to the script.",
    '$0 is set to the script name (or "bash" with -c).'
  ]
};

export const bashCommand: Command = {
  name: "bash",

  async execute(args: string[], ctx: CommandContext): Promise<ExecResult> {
    if (hasHelpFlag(args)) {
      return showHelp(bashHelp);
    }

    // Handle -c flag
    // With -c: bash -c 'command' arg0 arg1 arg2
    // arg0 becomes $0, arg1 becomes $1, arg2 becomes $2
    if (args[0] === "-c" && args.length >= 2) {
      const command = args[1];
      const scriptName = args[2] || "bash";
      const scriptArgs = args.slice(3);
      return executeScript(command, scriptName, scriptArgs, ctx);
    }

    // No arguments - read script from stdin if available
    if (args.length === 0) {
      if (ctx.stdin?.trim()) {
        return executeScript(ctx.stdin, "bash", [], ctx);
      }
      // No stdin - return success (interactive mode not supported)
      return { stdout: "", stderr: "", exitCode: 0 };
    }

    // Read and execute script file
    const scriptPath = args[0];
    const scriptArgs = args.slice(1);

    try {
      const fullPath = ctx.fs.resolvePath(ctx.cwd, scriptPath);
      const scriptContent = await ctx.fs.readFile(fullPath);
      return executeScript(scriptContent, scriptPath, scriptArgs, ctx);
    } catch {
      return {
        stdout: "",
        stderr: `bash: ${scriptPath}: No such file or directory\n`,
        exitCode: 127
      };
    }
  }
};

// sh is an alias for bash
export const shCommand: Command = {
  name: "sh",

  async execute(args: string[], ctx: CommandContext): Promise<ExecResult> {
    if (hasHelpFlag(args)) {
      return showHelp({
        ...bashHelp,
        name: "sh",
        summary: "execute shell commands or scripts (POSIX shell)"
      });
    }

    // Same implementation as bash
    // With -c: sh -c 'command' arg0 arg1 arg2
    // arg0 becomes $0, arg1 becomes $1, arg2 becomes $2
    if (args[0] === "-c" && args.length >= 2) {
      const command = args[1];
      const scriptName = args[2] || "sh";
      const scriptArgs = args.slice(3);
      return executeScript(command, scriptName, scriptArgs, ctx);
    }

    // No arguments - read script from stdin if available
    if (args.length === 0) {
      if (ctx.stdin?.trim()) {
        return executeScript(ctx.stdin, "sh", [], ctx);
      }
      // No stdin - return success (interactive mode not supported)
      return { stdout: "", stderr: "", exitCode: 0 };
    }

    const scriptPath = args[0];
    const scriptArgs = args.slice(1);

    try {
      const fullPath = ctx.fs.resolvePath(ctx.cwd, scriptPath);
      const scriptContent = await ctx.fs.readFile(fullPath);
      return executeScript(scriptContent, scriptPath, scriptArgs, ctx);
    } catch {
      return {
        stdout: "",
        stderr: `sh: ${scriptPath}: No such file or directory\n`,
        exitCode: 127
      };
    }
  }
};

async function executeScript(
  script: string,
  scriptName: string,
  scriptArgs: string[],
  ctx: CommandContext
): Promise<ExecResult> {
  if (!ctx.exec) {
    return {
      stdout: "",
      stderr: "bash: internal error: exec function not available\n",
      exitCode: 1
    };
  }

  // Build environment for the exec call
  // Include exported environment from parent (for prefix assignments like "FOO=bar exec sh -c '...'")
  // plus positional parameters
  // Use null-prototype object to prevent prototype pollution
  const positionalEnv = mergeToNullPrototype(ctx.exportedEnv || {}, {
    "0": scriptName,
    "#": String(scriptArgs.length),
    "@": scriptArgs.join(" "),
    "*": scriptArgs.join(" ")
  }) as Record<string, string>;
  scriptArgs.forEach((arg, i) => {
    positionalEnv[String(i + 1)] = arg;
  });

  // Skip shebang line if present
  let scriptToRun = script;
  if (scriptToRun.startsWith("#!")) {
    const firstNewline = scriptToRun.indexOf("\n");
    if (firstNewline !== -1) {
      scriptToRun = scriptToRun.slice(firstNewline + 1);
    }
  }

  // Execute the script as-is, preserving newlines for proper parsing
  // The parser needs to see the original structure to correctly handle
  // multi-line constructs like (( ... )) vs ( ( ... ) )
  // Pass stdin through to the nested script
  const result = await ctx.exec(scriptToRun, {
    env: positionalEnv,
    cwd: ctx.cwd,
    stdin: ctx.stdin,
    signal: ctx.signal
  });
  return result;
}

import type { CommandFuzzInfo } from "../fuzz-flags-types";

export const flagsForFuzzing: CommandFuzzInfo = {
  name: "bash",
  flags: [{ flag: "-c", type: "value", valueHint: "string" }],
  stdinType: "text"
};

export const shFlagsForFuzzing: CommandFuzzInfo = {
  name: "sh",
  flags: [{ flag: "-c", type: "value", valueHint: "string" }],
  stdinType: "text"
};
