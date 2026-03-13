/**
 * Type definitions for command fuzz flag metadata.
 * Used by fuzzing generators to automatically create flag combinations.
 */

export interface FuzzFlag {
  flag: string; // "-r", "--reverse"
  type: "boolean" | "value";
  valueHint?: "number" | "path" | "string" | "pattern" | "format" | "delimiter";
}

export interface CommandFuzzInfo {
  name: string;
  flags: FuzzFlag[];
  stdinType?: "text" | "json" | "binary" | "none";
  needsFiles?: boolean;
  needsArgs?: boolean;
  minArgs?: number;
}
