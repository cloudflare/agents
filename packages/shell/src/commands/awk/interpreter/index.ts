/**
 * AWK Interpreter Module
 *
 * Re-exports the public API for the AWK interpreter.
 */

export {
  type AwkRuntimeContext,
  type CreateContextOptions,
  createRuntimeContext
} from "./context";
export { AwkInterpreter } from "./interpreter";
export type { AwkFileSystem, AwkValue } from "./types";
