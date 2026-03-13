/**
 * Alias Expansion
 *
 * Handles bash alias expansion for SimpleCommandNodes.
 *
 * Alias expansion rules:
 * 1. Only expands if command name is a literal unquoted word
 * 2. Alias value is substituted for the command name
 * 3. If alias value ends with a space, the next word is also checked for alias expansion
 * 4. Recursive expansion is allowed but limited to prevent infinite loops
 */

import type { ScriptNode, SimpleCommandNode, WordNode } from "../ast/types";
import { Parser } from "../parser/parser";
import { ParseException } from "../parser/types";

/**
 * Alias prefix used in environment variables
 */
const ALIAS_PREFIX = "BASH_ALIAS_";

/**
 * Context needed for alias expansion operations
 */
export interface AliasExpansionContext {
  env: Map<string, string>;
}

/**
 * Check if a word is a literal unquoted word (eligible for alias expansion).
 * Aliases only expand for literal words, not for quoted strings or expansions.
 */
function isLiteralUnquotedWord(word: WordNode): boolean {
  // Must have exactly one part that is a literal
  if (word.parts.length !== 1) return false;
  const part = word.parts[0];
  // Must be a Literal part (not quoted, not an expansion)
  return part.type === "Literal";
}

/**
 * Get the literal value of a word if it's a simple literal
 */
function getLiteralValue(word: WordNode): string | null {
  if (word.parts.length !== 1) return null;
  const part = word.parts[0];
  if (part.type === "Literal") {
    return part.value;
  }
  return null;
}

/**
 * Get the alias value for a name, if defined
 */
function getAlias(
  ctx: AliasExpansionContext,
  name: string
): string | undefined {
  return ctx.env.get(`${ALIAS_PREFIX}${name}`);
}

/**
 * Expand alias in a SimpleCommandNode if applicable.
 * Returns a new node with the alias expanded, or the original node if no expansion.
 */
export function expandAlias(
  ctx: AliasExpansionContext,
  node: SimpleCommandNode,
  aliasExpansionStack: Set<string>
): SimpleCommandNode {
  // Need a command name to expand
  if (!node.name) return node;

  // Check if the command name is a literal unquoted word
  if (!isLiteralUnquotedWord(node.name)) return node;

  const cmdName = getLiteralValue(node.name);
  if (!cmdName) return node;

  // Check for alias
  const aliasValue = getAlias(ctx, cmdName);
  if (!aliasValue) return node;

  // Prevent infinite recursion
  if (aliasExpansionStack.has(cmdName)) return node;

  try {
    aliasExpansionStack.add(cmdName);

    // Parse the alias value as a command
    const parser = new Parser();
    // Build the full command line: alias value + original args
    // We need to combine the alias value with any remaining arguments
    let fullCommand = aliasValue;

    // Check if alias value ends with a space (triggers expansion of next word)
    const expandNext = aliasValue.endsWith(" ");

    // If not expanding next, append args directly
    if (!expandNext) {
      // Convert args to strings for re-parsing
      for (const arg of node.args) {
        const argLiteral = wordNodeToString(arg);
        fullCommand += ` ${argLiteral}`;
      }
    }

    // Parse the expanded command
    let expandedAst: ScriptNode;
    try {
      expandedAst = parser.parse(fullCommand);
    } catch (e) {
      // If parsing fails, return original node (let normal execution handle the error)
      if (e instanceof ParseException) {
        // Re-throw parse errors to be handled by the caller
        throw e;
      }
      return node;
    }

    // We expect exactly one statement with one command in the pipeline
    if (
      expandedAst.statements.length !== 1 ||
      expandedAst.statements[0].pipelines.length !== 1 ||
      expandedAst.statements[0].pipelines[0].commands.length !== 1
    ) {
      // Complex alias - might have multiple commands, pipelines, etc.
      // For now, execute as a script and wrap result
      // This is a simplification - full support would require more complex handling
      return handleComplexAlias(node, aliasValue);
    }

    const expandedCmd = expandedAst.statements[0].pipelines[0].commands[0];
    if (expandedCmd.type !== "SimpleCommand") {
      // Alias expanded to a compound command - let it execute directly
      return handleComplexAlias(node, aliasValue);
    }

    // Merge the expanded command with original node's context
    let newNode: SimpleCommandNode = {
      ...expandedCmd,
      // Preserve original assignments (prefix assignments like FOO=bar alias_cmd)
      assignments: [...node.assignments, ...expandedCmd.assignments],
      // Preserve original redirections
      redirections: [...expandedCmd.redirections, ...node.redirections],
      // Preserve line number
      line: node.line
    };

    // If alias ends with space, expand next word too (recursive alias on first arg)
    if (expandNext && node.args.length > 0) {
      // Add the original args to the expanded command's args
      newNode = {
        ...newNode,
        args: [...newNode.args, ...node.args]
      };

      // Now recursively expand the first arg if it's an alias
      if (newNode.args.length > 0) {
        const firstArg = newNode.args[0];
        if (isLiteralUnquotedWord(firstArg)) {
          const firstArgName = getLiteralValue(firstArg);
          if (firstArgName && getAlias(ctx, firstArgName)) {
            // Create a temporary node with the first arg as command
            const tempNode: SimpleCommandNode = {
              type: "SimpleCommand",
              name: firstArg,
              args: newNode.args.slice(1),
              assignments: [],
              redirections: []
            };
            const expandedFirst = expandAlias(
              ctx,
              tempNode,
              aliasExpansionStack
            );
            if (expandedFirst !== tempNode) {
              // Merge back
              newNode = {
                ...newNode,
                name: expandedFirst.name,
                args: [...expandedFirst.args]
              };
            }
          }
        }
      }
    }

    // NOTE: We don't recursively call expandAlias here anymore - the caller
    // handles iterative expansion to avoid issues with stack management.
    // The aliasExpansionStack is cleared by the caller after all expansions complete.

    return newNode;
  } catch (e) {
    // On error, clean up our entry from the stack
    aliasExpansionStack.delete(cmdName);
    throw e;
  }
  // NOTE: No finally block - we intentionally leave cmdName in the stack
  // to prevent re-expansion of the same alias. The caller clears the stack.
}

/**
 * Handle complex alias that expands to multiple commands or pipelines.
 * For now, we create a wrapper that will execute the alias as a script.
 */
function handleComplexAlias(
  node: SimpleCommandNode,
  aliasValue: string
): SimpleCommandNode {
  // Build complete command string
  let fullCommand = aliasValue;
  for (const arg of node.args) {
    const argLiteral = wordNodeToString(arg);
    fullCommand += ` ${argLiteral}`;
  }

  // Create an eval-like command that will execute the alias
  // This is a workaround - we create a new SimpleCommand that calls eval
  const parser = new Parser();
  const evalWord = parser.parseWordFromString("eval", false, false);
  const cmdWord = parser.parseWordFromString(
    `'${fullCommand.replace(/'/g, "'\\''")}'`,
    false,
    false
  );

  return {
    type: "SimpleCommand",
    name: evalWord,
    args: [cmdWord],
    assignments: node.assignments,
    redirections: node.redirections,
    line: node.line
  };
}

/**
 * Convert a WordNode back to a string representation for re-parsing.
 * This is a simplified conversion that handles common cases.
 */
function wordNodeToString(word: WordNode): string {
  let result = "";
  for (const part of word.parts) {
    switch (part.type) {
      case "Literal":
        // Escape special characters
        result += part.value.replace(/([\s"'$`\\*?[\]{}()<>|&;#!])/g, "\\$1");
        break;
      case "SingleQuoted":
        result += `'${part.value}'`;
        break;
      case "DoubleQuoted":
        // Handle double-quoted content
        result += `"${part.parts.map((p) => (p.type === "Literal" ? p.value : `$${p.type}`)).join("")}"`;
        break;
      case "ParameterExpansion":
        // Use braced form to be safe
        result += `\${${part.parameter}}`;
        break;
      case "CommandSubstitution":
        // CommandSubstitutionPart has body (ScriptNode), not command string
        // We need to reconstruct - for simplicity, wrap in $(...)
        result += `$(...)`;
        break;
      case "ArithmeticExpansion":
        result += `$((${part.expression}))`;
        break;
      case "Glob":
        result += part.pattern;
        break;
      default:
        // For other types, try to preserve as-is
        break;
    }
  }
  return result;
}
