/**
 * Built-in Command Handlers
 *
 * Shell built-in commands that modify interpreter state:
 * - cd: Change directory
 * - declare/typeset: Declare variables with attributes
 * - export: Set environment variables
 * - unset: Remove variables/functions
 * - exit: Exit shell
 * - local: Declare local variables in functions
 * - readonly: Declare readonly variables
 * - set: Set/unset shell options
 * - break: Exit from loops
 * - continue: Skip to next loop iteration
 * - return: Return from a function
 * - eval: Execute arguments as a shell command
 * - let: Evaluate arithmetic expressions
 * - shift: Shift positional parameters
 * - read: Read a line of input
 * - source/.: Execute commands from a file in current environment
 */

export { handleBreak } from "./break";
export { handleCd } from "./cd";
export { handleCompgen } from "./compgen";
export { handleComplete } from "./complete";
export { handleCompopt } from "./compopt";
export { handleContinue } from "./continue";
export {
  applyCaseTransform,
  handleDeclare,
  handleReadonly,
  isInteger
} from "./declare";
export { handleDirs, handlePopd, handlePushd } from "./dirs";
export { handleEval } from "./eval";
export { handleExit } from "./exit";
export { handleExport } from "./export";
export { handleGetopts } from "./getopts";
export { handleHash } from "./hash";
export { handleHelp } from "./help";
export { handleLet } from "./let";
export { handleLocal } from "./local";
export { handleMapfile } from "./mapfile";
export { handleRead } from "./read";
export { handleReturn } from "./return";
export { handleSet } from "./set";
export { handleShift } from "./shift";
export { handleSource } from "./source";
export { handleUnset } from "./unset";
export { getLocalVarDepth } from "./variable-assignment";
