/**
 * Command Substitution Helpers
 *
 * Helper functions for handling command substitution patterns.
 */

import type { ScriptNode, SimpleCommandNode, WordNode } from "../../ast/types";

/**
 * Check if a command substitution body matches the $(<file) shorthand pattern.
 * This is a special case where $(< file) is equivalent to $(cat file) but reads
 * the file directly without spawning a subprocess.
 *
 * For this to match, the body must consist of:
 * - One statement without operators (no && or ||)
 * - One pipeline with one command
 * - A SimpleCommand with no name, no args, no assignments
 * - Exactly one input redirection (<)
 *
 * Note: The special $(<file) behavior only works when it's the ONLY element
 * in the command substitution. $(< file; cmd) or $(cmd; < file) are NOT special.
 */
export function getFileReadShorthand(
  body: ScriptNode
): { target: WordNode } | null {
  // Must have exactly one statement
  if (body.statements.length !== 1) return null;

  const statement = body.statements[0];
  // Must not have any operators (no && or ||)
  if (statement.operators.length !== 0) return null;
  // Must have exactly one pipeline
  if (statement.pipelines.length !== 1) return null;

  const pipeline = statement.pipelines[0];
  // Must not be negated
  if (pipeline.negated) return null;
  // Must have exactly one command
  if (pipeline.commands.length !== 1) return null;

  const cmd = pipeline.commands[0];
  // Must be a SimpleCommand
  if (cmd.type !== "SimpleCommand") return null;

  const simpleCmd = cmd as SimpleCommandNode;
  // Must have no command name
  if (simpleCmd.name !== null) return null;
  // Must have no arguments
  if (simpleCmd.args.length !== 0) return null;
  // Must have no assignments
  if (simpleCmd.assignments.length !== 0) return null;
  // Must have exactly one redirection
  if (simpleCmd.redirections.length !== 1) return null;

  const redirect = simpleCmd.redirections[0];
  // Must be an input redirection (<)
  if (redirect.operator !== "<") return null;
  // Target must be a WordNode (not heredoc)
  if (redirect.target.type !== "Word") return null;

  return { target: redirect.target };
}
