// Types for find command implementation

// Expression types for find predicates
export type Expression =
  | { type: "name"; pattern: string; ignoreCase?: boolean }
  | { type: "path"; pattern: string; ignoreCase?: boolean }
  | { type: "regex"; pattern: string; ignoreCase?: boolean }
  | { type: "type"; fileType: "f" | "d" }
  | { type: "empty" }
  | { type: "mtime"; days: number; comparison: "exact" | "more" | "less" }
  | { type: "newer"; refPath: string }
  | {
      type: "size";
      value: number;
      unit: SizeUnit;
      comparison: "exact" | "more" | "less";
    }
  | {
      type: "perm";
      mode: number;
      matchType: "exact" | "all" | "any"; // exact, -mode (all), /mode (any)
    }
  | { type: "prune" } // Returns true and prevents descending into directories
  | { type: "print" } // Returns true and marks path for printing
  | { type: "not"; expr: Expression }
  | { type: "and"; left: Expression; right: Expression }
  | { type: "or"; left: Expression; right: Expression };

export type SizeUnit = "c" | "k" | "M" | "G" | "b";

// Action types for find
export type FindAction =
  | { type: "exec"; command: string[]; batchMode: boolean }
  | { type: "print" }
  | { type: "print0" }
  | { type: "printf"; format: string }
  | { type: "delete" };

// Evaluation context for file matching
export interface EvalContext {
  name: string;
  relativePath: string;
  isFile: boolean;
  isDirectory: boolean;
  isEmpty: boolean;
  mtime: number; // modification time as timestamp
  size: number; // file size in bytes
  mode: number; // file permission mode
  newerRefTimes: Map<string, number>; // reference file mtimes for -newer
  depth?: number; // depth in directory tree (for -printf %d)
  startingPoint?: string; // starting search path (for -printf %P)
}

// Evaluation result including prune and print flags
export interface EvalResult {
  matches: boolean;
  pruned: boolean; // Set to true if -prune was evaluated and matched
  printed: boolean; // Set to true if -print was evaluated and matched
}

// Parse result from expression parser
export interface ParseResult {
  expr: Expression | null;
  pathIndex: number;
  error?: string;
  actions: FindAction[];
}
