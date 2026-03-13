/**
 * compgen - Generate completion matches
 *
 * Usage:
 *   compgen -v [prefix]         - List variable names (optionally starting with prefix)
 *   compgen -A variable [prefix] - Same as -v
 *   compgen -A function [prefix] - List function names
 *   compgen -e [prefix]          - List exported variable names
 *   compgen -A builtin [prefix]  - List builtin command names
 *   compgen -A keyword [prefix]  - List shell keywords (alias: -k)
 *   compgen -A alias [prefix]    - List alias names
 *   compgen -A shopt [prefix]    - List shopt options
 *   compgen -A helptopic [prefix] - List help topics
 *   compgen -A directory [prefix] - List directory names
 *   compgen -A file [prefix]      - List file names
 *   compgen -f [prefix]           - List file names (alias for -A file)
 *   compgen -A user               - List user names
 *   compgen -A command [prefix]   - List commands (builtins, functions, aliases, external)
 *   compgen -W wordlist [prefix]  - Generate from wordlist
 *   compgen -P prefix             - Prefix to add to completions
 *   compgen -S suffix             - Suffix to add to completions
 *   compgen -o option             - Completion option (plusdirs, dirnames, default, etc.)
 */

import { type ParseException, Parser, parse } from "../../parser/parser";
import type { ExecResult } from "../../types";
import { matchPattern } from "../conditionals";
import { expandWord, getArrayElements } from "../expansion";
import { callFunction } from "../functions";
import { failure, result, success } from "../helpers/result";
import type { InterpreterContext } from "../types";

// List of shell keywords (matches bash)
const SHELL_KEYWORDS = [
  "!",
  "[[",
  "]]",
  "case",
  "do",
  "done",
  "elif",
  "else",
  "esac",
  "fi",
  "for",
  "function",
  "if",
  "in",
  "then",
  "time",
  "until",
  "while",
  "{",
  "}"
];

// List of shell builtins
const SHELL_BUILTINS = [
  ".",
  ":",
  "[",
  "alias",
  "bg",
  "bind",
  "break",
  "builtin",
  "caller",
  "cd",
  "command",
  "compgen",
  "complete",
  "compopt",
  "continue",
  "declare",
  "dirs",
  "disown",
  "echo",
  "enable",
  "eval",
  "exec",
  "exit",
  "export",
  "false",
  "fc",
  "fg",
  "getopts",
  "hash",
  "help",
  "history",
  "jobs",
  "kill",
  "let",
  "local",
  "logout",
  "mapfile",
  "popd",
  "printf",
  "pushd",
  "pwd",
  "read",
  "readarray",
  "readonly",
  "return",
  "set",
  "shift",
  "shopt",
  "source",
  "suspend",
  "test",
  "times",
  "trap",
  "true",
  "type",
  "typeset",
  "ulimit",
  "umask",
  "unalias",
  "unset",
  "wait"
];

// List of shopt options
const SHOPT_OPTIONS = [
  "autocd",
  "assoc_expand_once",
  "cdable_vars",
  "cdspell",
  "checkhash",
  "checkjobs",
  "checkwinsize",
  "cmdhist",
  "compat31",
  "compat32",
  "compat40",
  "compat41",
  "compat42",
  "compat43",
  "compat44",
  "complete_fullquote",
  "direxpand",
  "dirspell",
  "dotglob",
  "execfail",
  "expand_aliases",
  "extdebug",
  "extglob",
  "extquote",
  "failglob",
  "force_fignore",
  "globasciiranges",
  "globstar",
  "gnu_errfmt",
  "histappend",
  "histreedit",
  "histverify",
  "hostcomplete",
  "huponexit",
  "inherit_errexit",
  "interactive_comments",
  "lastpipe",
  "lithist",
  "localvar_inherit",
  "localvar_unset",
  "login_shell",
  "mailwarn",
  "no_empty_cmd_completion",
  "nocaseglob",
  "nocasematch",
  "nullglob",
  "progcomp",
  "progcomp_alias",
  "promptvars",
  "restricted_shell",
  "shift_verbose",
  "sourcepath",
  "xpg_echo"
];

// List of help topics (builtin command names that have help)
const HELP_TOPICS = SHELL_BUILTINS;

export async function handleCompgen(
  ctx: InterpreterContext,
  args: string[]
): Promise<ExecResult> {
  // Parse options
  const actionTypes: string[] = []; // Support multiple -A flags
  let wordlist: string | null = null;
  let prefix = "";
  let suffix = "";
  let searchPrefix: string | null = null;
  let plusdirsOption = false;
  let dirnamesOption = false;
  let defaultOption = false;
  let excludePattern: string | null = null;
  let functionName: string | null = null;
  let commandString: string | null = null;
  const processedArgs: string[] = [];

  const validActions = [
    "alias",
    "arrayvar",
    "binding",
    "builtin",
    "command",
    "directory",
    "disabled",
    "enabled",
    "export",
    "file",
    "function",
    "group",
    "helptopic",
    "hostname",
    "job",
    "keyword",
    "running",
    "service",
    "setopt",
    "shopt",
    "signal",
    "stopped",
    "user",
    "variable"
  ];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === "-v") {
      actionTypes.push("variable");
    } else if (arg === "-e") {
      actionTypes.push("export");
    } else if (arg === "-f") {
      actionTypes.push("file");
    } else if (arg === "-d") {
      actionTypes.push("directory");
    } else if (arg === "-k") {
      actionTypes.push("keyword");
    } else if (arg === "-A") {
      // Next arg is the action type
      i++;
      if (i >= args.length) {
        return failure("compgen: -A: option requires an argument\n", 2);
      }
      const actionType = args[i];
      if (!validActions.includes(actionType)) {
        return failure(`compgen: ${actionType}: invalid action name\n`, 2);
      }
      actionTypes.push(actionType);
    } else if (arg === "-W") {
      // Word list
      i++;
      if (i >= args.length) {
        return failure("compgen: -W: option requires an argument\n", 2);
      }
      wordlist = args[i];
    } else if (arg === "-P") {
      // Prefix to add
      i++;
      if (i >= args.length) {
        return failure("compgen: -P: option requires an argument\n", 2);
      }
      prefix = args[i];
    } else if (arg === "-S") {
      // Suffix to add
      i++;
      if (i >= args.length) {
        return failure("compgen: -S: option requires an argument\n", 2);
      }
      suffix = args[i];
    } else if (arg === "-o") {
      // Completion option
      i++;
      if (i >= args.length) {
        return failure("compgen: -o: option requires an argument\n", 2);
      }
      const opt = args[i];
      if (opt === "plusdirs") {
        plusdirsOption = true;
      } else if (opt === "dirnames") {
        dirnamesOption = true;
      } else if (opt === "default") {
        defaultOption = true;
      } else if (
        opt === "filenames" ||
        opt === "nospace" ||
        opt === "bashdefault" ||
        opt === "noquote"
      ) {
        // These are postprocessing options that affect display, not generation
        // They have no effect with compgen (only with complete)
      } else {
        return failure(`compgen: ${opt}: invalid option name\n`, 2);
      }
    } else if (arg === "-F") {
      // Function to call for generating completions
      i++;
      if (i >= args.length) {
        return failure("compgen: -F: option requires an argument\n", 2);
      }
      functionName = args[i];
    } else if (arg === "-C") {
      // Command to run for completion
      i++;
      if (i >= args.length) {
        return failure("compgen: -C: option requires an argument\n", 2);
      }
      commandString = args[i];
    } else if (arg === "-X") {
      // Pattern to exclude
      i++;
      if (i >= args.length) {
        return failure("compgen: -X: option requires an argument\n", 2);
      }
      excludePattern = args[i];
    } else if (arg === "-G") {
      // Glob pattern
      i++;
      if (i >= args.length) {
        return failure("compgen: -G: option requires an argument\n", 2);
      }
      // Skip glob for now - -G is not implemented
    } else if (arg === "--") {
      // End of options
      processedArgs.push(...args.slice(i + 1));
      break;
    } else if (!arg.startsWith("-")) {
      processedArgs.push(arg);
    }
  }

  // The search prefix is the first non-option argument
  searchPrefix = processedArgs[0] ?? null;

  // Collect completions
  const completions: string[] = [];

  // Handle -o dirnames (only show directories)
  if (dirnamesOption) {
    const dirCompletions = await getDirectoryCompletions(ctx, searchPrefix);
    completions.push(...dirCompletions);
  }

  // Handle -o default (show files)
  if (defaultOption) {
    const fileCompletions = await getFileCompletions(ctx, searchPrefix);
    completions.push(...fileCompletions);
  }

  // Handle action types - loop through all of them to support multiple -A flags
  // NOTE: Action types are processed BEFORE wordlist to match bash behavior
  // where -A directory results come before -W wordlist results
  for (const actionType of actionTypes) {
    if (actionType === "variable") {
      const vars = getVariableNames(ctx, searchPrefix);
      completions.push(...vars);
    } else if (actionType === "export") {
      const vars = getExportedVariableNames(ctx, searchPrefix);
      completions.push(...vars);
    } else if (actionType === "function") {
      const funcs = getFunctionNames(ctx, searchPrefix);
      completions.push(...funcs);
    } else if (actionType === "builtin") {
      const builtins = getBuiltinNames(searchPrefix);
      completions.push(...builtins);
    } else if (actionType === "keyword") {
      const keywords = getKeywordNames(searchPrefix);
      completions.push(...keywords);
    } else if (actionType === "alias") {
      const aliases = getAliasNames(ctx, searchPrefix);
      completions.push(...aliases);
    } else if (actionType === "shopt") {
      const shopts = getShoptNames(searchPrefix);
      completions.push(...shopts);
    } else if (actionType === "helptopic") {
      const topics = getHelpTopicNames(searchPrefix);
      completions.push(...topics);
    } else if (actionType === "directory") {
      const dirs = await getDirectoryCompletions(ctx, searchPrefix);
      completions.push(...dirs);
    } else if (actionType === "file") {
      const files = await getFileCompletions(ctx, searchPrefix);
      completions.push(...files);
    } else if (actionType === "user") {
      const users = getUserNames(searchPrefix);
      completions.push(...users);
    } else if (actionType === "command") {
      const commands = await getCommandCompletions(ctx, searchPrefix);
      completions.push(...commands);
    }
  }

  // Handle wordlist AFTER action types
  // This ensures -A directory results come before -W wordlist results
  if (wordlist !== null) {
    try {
      // First, expand the wordlist (handles $(), ${}, etc.)
      const expandedWordlist = await expandWordlistString(ctx, wordlist);
      const words = splitWordlist(ctx, expandedWordlist);
      for (const word of words) {
        if (searchPrefix === null || word.startsWith(searchPrefix)) {
          completions.push(word);
        }
      }
    } catch {
      // Expansion errors (e.g., arithmetic division by zero) return status 1
      return result("", "", 1);
    }
  }

  // Handle -o plusdirs: add directories to completions
  if (plusdirsOption) {
    const dirCompletions = await getDirectoryCompletions(ctx, searchPrefix);
    for (const dir of dirCompletions) {
      if (!completions.includes(dir)) {
        completions.push(dir);
      }
    }
  }

  // Handle -F function: call function to generate completions
  // Track stdout from function (prepended to completions output)
  let functionStdout = "";
  if (functionName !== null) {
    const func = ctx.state.functions.get(functionName);
    if (func) {
      // Set up COMP_* variables that bash provides to completion functions
      // When called via compgen (not during actual completion), bash sets:
      // COMP_WORDS: empty array
      // COMP_CWORD: -1
      // COMP_LINE: empty string
      // COMP_POINT: 0
      const savedEnv = new Map<string, string | undefined>();

      // Save and set COMP_WORDS (empty array - no elements)
      savedEnv.set(
        "COMP_WORDS__length",
        ctx.state.env.get("COMP_WORDS__length")
      );
      ctx.state.env.set("COMP_WORDS__length", "0");

      // Save and set COMP_CWORD
      savedEnv.set("COMP_CWORD", ctx.state.env.get("COMP_CWORD"));
      ctx.state.env.set("COMP_CWORD", "-1");

      // Save and set COMP_LINE
      savedEnv.set("COMP_LINE", ctx.state.env.get("COMP_LINE"));
      ctx.state.env.set("COMP_LINE", "");

      // Save and set COMP_POINT
      savedEnv.set("COMP_POINT", ctx.state.env.get("COMP_POINT"));
      ctx.state.env.set("COMP_POINT", "0");

      // Clear any existing COMPREPLY
      const savedCompreply = new Map<string, string | undefined>();
      for (const key of ctx.state.env.keys()) {
        if (
          key === "COMPREPLY" ||
          key.startsWith("COMPREPLY_") ||
          key === "COMPREPLY__length"
        ) {
          savedCompreply.set(key, ctx.state.env.get(key));
          ctx.state.env.delete(key);
        }
      }

      // Determine the arguments to pass to the function
      // bash passes: command_name, word_being_completed, previous_word
      // For compgen -F func cmd [word], it's: "compgen", cmd, ""
      const funcArgs = ["compgen", processedArgs[0] ?? "", ""];

      try {
        // Call the function - errors during execution return exit code 1
        const funcResult = await callFunction(ctx, func, funcArgs, "");

        // Check if there was an error (e.g., division by zero)
        if (funcResult.exitCode !== 0) {
          // Restore saved environment
          restoreEnv(ctx, savedEnv);
          restoreEnv(ctx, savedCompreply);
          return result("", funcResult.stderr, 1);
        }

        // Capture function stdout (e.g., debug output from the function)
        functionStdout = funcResult.stdout;

        // Get COMPREPLY values (supports both scalar and array)
        const compreplyValues = getCompreplyValues(ctx);
        completions.push(...compreplyValues);
      } catch {
        // If function execution fails, return exit code 1
        restoreEnv(ctx, savedEnv);
        restoreEnv(ctx, savedCompreply);
        return result("", "", 1);
      }

      // Restore saved environment
      restoreEnv(ctx, savedEnv);
      restoreEnv(ctx, savedCompreply);
    }
  }

  // Handle -C command: execute command and use output lines as completions
  // Note: Unlike -W and -A, -C does not filter by searchPrefix.
  // The command is responsible for generating appropriate completions.
  if (commandString !== null) {
    try {
      // Parse and execute the command
      const ast = parse(commandString);
      const cmdResult = await ctx.executeScript(ast);

      // Check for errors
      if (cmdResult.exitCode !== 0) {
        return result("", cmdResult.stderr, cmdResult.exitCode);
      }

      // Split stdout into lines and add as completions
      // All non-empty lines are used as completions (no prefix filtering)
      if (cmdResult.stdout) {
        const lines = cmdResult.stdout.split("\n");
        for (const line of lines) {
          // Skip empty lines
          if (line.length > 0) {
            completions.push(line);
          }
        }
      }
    } catch (error) {
      // Handle parse errors
      if ((error as ParseException).name === "ParseException") {
        return failure(`compgen: -C: ${(error as Error).message}\n`, 2);
      }
      throw error;
    }
  }

  // Apply -X filter: remove completions matching the exclude pattern
  // Uses extglob for pattern matching (compgen always uses extglob)
  // Special: if pattern starts with '!', the filter is negated (keep items matching the rest)
  let filteredCompletions = completions;
  if (excludePattern !== null) {
    // Check for negation prefix
    const isNegated = excludePattern.startsWith("!");
    const pattern = isNegated ? excludePattern.slice(1) : excludePattern;

    filteredCompletions = completions.filter((c) => {
      // Match using extglob patterns
      const matches = matchPattern(c, pattern, false, true);
      // Normal: filter OUT matching completions (!matches)
      // Negated: filter OUT non-matching completions (matches)
      // i.e., keep items that match when negated
      return isNegated ? matches : !matches;
    });
  }

  // If no completions found and we had a search prefix, return exit code 1
  if (filteredCompletions.length === 0 && searchPrefix !== null) {
    // Still output any function stdout even if no completions
    return result(functionStdout, "", 1);
  }

  // Apply prefix/suffix and output
  const completionOutput = filteredCompletions
    .map((c) => `${prefix}${c}${suffix}`)
    .join("\n");
  // Prepend function stdout to completions output
  const output =
    functionStdout + (completionOutput ? `${completionOutput}\n` : "");
  return success(output);
}

/**
 * Get all variable names, optionally filtered by prefix
 */
function getVariableNames(
  ctx: InterpreterContext,
  prefix: string | null
): string[] {
  const names: Set<string> = new Set();

  // Add all environment variables
  for (const key of ctx.state.env.keys()) {
    // Skip internal array markers
    if (key.includes("_") && /^[a-zA-Z_][a-zA-Z0-9_]*_\d+$/.test(key)) {
      continue;
    }
    if (key.endsWith("__length")) {
      continue;
    }
    // Extract base name for array variables
    const baseName = key.split("_")[0];
    if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key)) {
      names.add(key);
    } else if (
      baseName &&
      /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(baseName) &&
      ctx.state.env.has(`${baseName}__length`)
    ) {
      names.add(baseName);
    }
  }

  // Filter by prefix if provided
  let resultArr = Array.from(names);
  if (prefix !== null) {
    resultArr = resultArr.filter((n) => n.startsWith(prefix));
  }

  // Sort alphabetically
  return resultArr.sort();
}

/**
 * Get exported variable names, optionally filtered by prefix
 */
function getExportedVariableNames(
  ctx: InterpreterContext,
  prefix: string | null
): string[] {
  const exportedVars = ctx.state.exportedVars ?? new Set<string>();
  let resultArr = Array.from(exportedVars);

  // Filter by prefix if provided
  if (prefix !== null) {
    resultArr = resultArr.filter((n) => n.startsWith(prefix));
  }

  // Filter out variables that don't exist or are internal
  resultArr = resultArr.filter((n) => {
    if (n.includes("_") && /^[a-zA-Z_][a-zA-Z0-9_]*_\d+$/.test(n)) {
      return false;
    }
    if (n.endsWith("__length")) {
      return false;
    }
    return ctx.state.env.has(n);
  });

  // Sort alphabetically
  return resultArr.sort();
}

/**
 * Get function names, optionally filtered by prefix
 */
function getFunctionNames(
  ctx: InterpreterContext,
  prefix: string | null
): string[] {
  let resultArr = Array.from(ctx.state.functions.keys());

  // Filter by prefix if provided
  if (prefix !== null) {
    resultArr = resultArr.filter((n) => n.startsWith(prefix));
  }

  // Sort alphabetically
  return resultArr.sort();
}

/**
 * Get builtin command names, optionally filtered by prefix
 */
function getBuiltinNames(prefix: string | null): string[] {
  let resultArr = [...SHELL_BUILTINS];

  // Filter by prefix if provided
  if (prefix !== null) {
    resultArr = resultArr.filter((n) => n.startsWith(prefix));
  }

  // Sort alphabetically
  return resultArr.sort();
}

/**
 * Get shell keyword names, optionally filtered by prefix
 */
function getKeywordNames(prefix: string | null): string[] {
  let resultArr = [...SHELL_KEYWORDS];

  // Filter by prefix if provided
  if (prefix !== null) {
    resultArr = resultArr.filter((n) => n.startsWith(prefix));
  }

  // Sort alphabetically
  return resultArr.sort();
}

/**
 * Get alias names, optionally filtered by prefix
 */
function getAliasNames(
  ctx: InterpreterContext,
  prefix: string | null
): string[] {
  const names: string[] = [];

  // Look for BASH_ALIAS_ prefixed variables
  for (const key of ctx.state.env.keys()) {
    if (key.startsWith("BASH_ALIAS_")) {
      const aliasName = key.slice("BASH_ALIAS_".length);
      names.push(aliasName);
    }
  }

  // Filter by prefix if provided
  let resultArr = names;
  if (prefix !== null) {
    resultArr = resultArr.filter((n) => n.startsWith(prefix));
  }

  // Sort alphabetically
  return resultArr.sort();
}

/**
 * Get shopt option names, optionally filtered by prefix
 */
function getShoptNames(prefix: string | null): string[] {
  let resultArr = [...SHOPT_OPTIONS];

  // Filter by prefix if provided
  if (prefix !== null) {
    resultArr = resultArr.filter((n) => n.startsWith(prefix));
  }

  // Sort alphabetically
  return resultArr.sort();
}

/**
 * Get help topic names, optionally filtered by prefix
 */
function getHelpTopicNames(prefix: string | null): string[] {
  let resultArr = [...HELP_TOPICS];

  // Filter by prefix if provided
  if (prefix !== null) {
    resultArr = resultArr.filter((n) => n.startsWith(prefix));
  }

  // Sort alphabetically
  return resultArr.sort();
}

/**
 * Get directory completions
 */
async function getDirectoryCompletions(
  ctx: InterpreterContext,
  prefix: string | null
): Promise<string[]> {
  const results: string[] = [];

  try {
    // Determine the directory to search and the prefix to match
    let searchDir = ctx.state.cwd;
    let matchPrefix = prefix ?? "";

    if (prefix) {
      // Check if prefix contains a directory path
      const lastSlash = prefix.lastIndexOf("/");
      if (lastSlash !== -1) {
        const dirPart = prefix.slice(0, lastSlash) || "/";
        matchPrefix = prefix.slice(lastSlash + 1);

        // Resolve the directory path
        if (dirPart.startsWith("/")) {
          searchDir = dirPart;
        } else {
          searchDir = `${ctx.state.cwd}/${dirPart}`;
        }
      }
    }

    // Read directory entries
    const entries = await ctx.fs.readdir(searchDir);

    for (const entry of entries) {
      // Check if it's a directory
      const fullPath = `${searchDir}/${entry}`;
      try {
        const stat = await ctx.fs.stat(fullPath);
        if (stat.isDirectory) {
          if (!matchPrefix || entry.startsWith(matchPrefix)) {
            // Include path prefix if the original prefix had one
            if (prefix?.includes("/")) {
              const lastSlash = prefix.lastIndexOf("/");
              const dirPart = prefix.slice(0, lastSlash + 1);
              results.push(dirPart + entry);
            } else {
              results.push(entry);
            }
          }
        }
      } catch {
        // Ignore stat errors
      }
    }
  } catch {
    // Ignore directory read errors
  }

  return results.sort();
}

/**
 * Get file completions (files and directories)
 */
async function getFileCompletions(
  ctx: InterpreterContext,
  prefix: string | null
): Promise<string[]> {
  const results: string[] = [];

  try {
    // Determine the directory to search and the prefix to match
    let searchDir = ctx.state.cwd;
    let matchPrefix = prefix ?? "";

    if (prefix) {
      // Check if prefix contains a directory path
      const lastSlash = prefix.lastIndexOf("/");
      if (lastSlash !== -1) {
        const dirPart = prefix.slice(0, lastSlash) || "/";
        matchPrefix = prefix.slice(lastSlash + 1);

        // Resolve the directory path
        if (dirPart.startsWith("/")) {
          searchDir = dirPart;
        } else {
          searchDir = `${ctx.state.cwd}/${dirPart}`;
        }
      }
    }

    // Read directory entries
    const entries = await ctx.fs.readdir(searchDir);

    for (const entry of entries) {
      if (!matchPrefix || entry.startsWith(matchPrefix)) {
        // Include path prefix if the original prefix had one
        if (prefix?.includes("/")) {
          const lastSlash = prefix.lastIndexOf("/");
          const dirPart = prefix.slice(0, lastSlash + 1);
          results.push(dirPart + entry);
        } else {
          results.push(entry);
        }
      }
    }
  } catch {
    // Ignore directory read errors
  }

  return results.sort();
}

/**
 * Get user names (stub - returns common system users)
 */
function getUserNames(_prefix: string | null): string[] {
  // In a real implementation, this would read /etc/passwd
  // For now, return some common user names
  return ["root", "nobody"];
}

/**
 * Get command completions (builtins, functions, aliases, external commands)
 */
async function getCommandCompletions(
  ctx: InterpreterContext,
  prefix: string | null
): Promise<string[]> {
  const commands: Set<string> = new Set();

  // Add builtins
  for (const builtin of SHELL_BUILTINS) {
    commands.add(builtin);
  }

  // Add functions
  for (const func of ctx.state.functions.keys()) {
    commands.add(func);
  }

  // Add aliases
  for (const key of ctx.state.env.keys()) {
    if (key.startsWith("BASH_ALIAS_")) {
      commands.add(key.slice("BASH_ALIAS_".length));
    }
  }

  // Add keywords
  for (const keyword of SHELL_KEYWORDS) {
    commands.add(keyword);
  }

  // Add external commands from PATH
  const path = ctx.state.env.get("PATH") ?? "/usr/bin:/bin";
  for (const dir of path.split(":")) {
    if (!dir) continue;
    try {
      const entries = await ctx.fs.readdir(dir);
      for (const entry of entries) {
        commands.add(entry);
      }
    } catch {
      // Ignore errors
    }
  }

  // Filter by prefix
  let resultArr = Array.from(commands);
  if (prefix !== null) {
    resultArr = resultArr.filter((c) => c.startsWith(prefix));
  }

  return resultArr.sort();
}

/**
 * Expand a wordlist string, handling command substitution ($()),
 * variable expansion (${}, $VAR), arithmetic expansion ($(())), etc.
 * Throws on expansion errors (e.g., division by zero).
 */
async function expandWordlistString(
  ctx: InterpreterContext,
  wordlist: string
): Promise<string> {
  const parser = new Parser();
  // Parse the wordlist as a word (not in quotes, so expansions apply)
  const wordNode = parser.parseWordFromString(wordlist, false, false);
  // Expand the word - this handles $(), ${}, etc.
  // Errors (like arithmetic errors) will propagate up
  return await expandWord(ctx, wordNode);
}

/**
 * Split a wordlist string into individual words, respecting IFS
 * Backslash-escaped IFS characters are treated as literal characters, not delimiters
 */
function splitWordlist(ctx: InterpreterContext, wordlist: string): string[] {
  const ifs = ctx.state.env.get("IFS") ?? " \t\n";

  if (ifs.length === 0) {
    return [wordlist];
  }

  // Build a set of IFS characters for fast lookup
  const ifsSet = new Set(ifs.split(""));

  // Parse the wordlist character by character, respecting backslash escapes
  const words: string[] = [];
  let currentWord = "";
  let i = 0;

  while (i < wordlist.length) {
    const char = wordlist[i];

    if (char === "\\" && i + 1 < wordlist.length) {
      // Backslash escape: the next character is literal (not a delimiter)
      const nextChar = wordlist[i + 1];
      currentWord += nextChar;
      i += 2;
    } else if (ifsSet.has(char)) {
      // This is an IFS delimiter
      if (currentWord.length > 0) {
        words.push(currentWord);
        currentWord = "";
      }
      i++;
    } else {
      // Regular character
      currentWord += char;
      i++;
    }
  }

  // Don't forget the last word
  if (currentWord.length > 0) {
    words.push(currentWord);
  }

  return words;
}

/**
 * Restore environment variables from saved values
 */
function restoreEnv(
  ctx: InterpreterContext,
  saved: Map<string, string | undefined>
): void {
  for (const [key, value] of saved) {
    if (value === undefined) {
      ctx.state.env.delete(key);
    } else {
      ctx.state.env.set(key, value);
    }
  }
}

/**
 * Get COMPREPLY values (supports both scalar and array)
 * Returns values in order, skipping sparse array gaps
 */
function getCompreplyValues(ctx: InterpreterContext): string[] {
  const values: string[] = [];

  // Check if COMPREPLY is an array
  const lengthKey = "COMPREPLY__length";
  const arrayLength = ctx.state.env.get(lengthKey);

  if (arrayLength !== undefined) {
    // It's an array - get elements using getArrayElements helper
    // getArrayElements returns Array<[index, value]>
    const elements = getArrayElements(ctx, "COMPREPLY");
    for (const [, value] of elements) {
      values.push(value);
    }
  } else {
    // Check if it's a scalar value
    const scalarValue = ctx.state.env.get("COMPREPLY");
    if (scalarValue !== undefined) {
      values.push(scalarValue);
    }
  }

  return values;
}
