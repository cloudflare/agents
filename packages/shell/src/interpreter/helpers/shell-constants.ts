/**
 * Shell Constants
 *
 * Constants for shell builtins, keywords, and POSIX special builtins.
 */

/**
 * POSIX special built-in commands.
 * In POSIX mode, these have special behaviors:
 * - Prefix assignments persist after the command
 * - Cannot be redefined as functions
 * - Errors may be fatal
 */
export const POSIX_SPECIAL_BUILTINS: Set<string> = new Set([
  ":",
  ".",
  "break",
  "continue",
  "eval",
  "exec",
  "exit",
  "export",
  "readonly",
  "return",
  "set",
  "shift",
  "trap",
  "unset"
]);

/**
 * Check if a command name is a POSIX special built-in
 */
export function isPosixSpecialBuiltin(name: string): boolean {
  return POSIX_SPECIAL_BUILTINS.has(name);
}

/**
 * Shell keywords (for type, command -v, etc.)
 */
export const SHELL_KEYWORDS: Set<string> = new Set([
  "if",
  "then",
  "else",
  "elif",
  "fi",
  "case",
  "esac",
  "for",
  "select",
  "while",
  "until",
  "do",
  "done",
  "in",
  "function",
  "{",
  "}",
  "time",
  "[[",
  "]]",
  "!"
]);

/**
 * Shell builtins (for type, command -v, builtin, etc.)
 */
export const SHELL_BUILTINS: Set<string> = new Set([
  ":",
  "true",
  "false",
  "cd",
  "export",
  "unset",
  "exit",
  "local",
  "set",
  "break",
  "continue",
  "return",
  "eval",
  "shift",
  "getopts",
  "compgen",
  "complete",
  "compopt",
  "pushd",
  "popd",
  "dirs",
  "source",
  ".",
  "read",
  "mapfile",
  "readarray",
  "declare",
  "typeset",
  "readonly",
  "let",
  "command",
  "shopt",
  "exec",
  "test",
  "[",
  "echo",
  "printf",
  "pwd",
  "alias",
  "unalias",
  "type",
  "hash",
  "ulimit",
  "umask",
  "trap",
  "times",
  "wait",
  "kill",
  "jobs",
  "fg",
  "bg",
  "disown",
  "suspend",
  "fc",
  "history",
  "help",
  "enable",
  "builtin",
  "caller"
]);
