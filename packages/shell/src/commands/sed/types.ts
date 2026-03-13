// Types for sed command implementation

// Address with stepping support (e.g., 0~2 for every other line)
export interface StepAddress {
  first: number;
  step: number;
}

// Relative offset address (GNU extension: ,+N)
export interface RelativeOffset {
  offset: number;
}

export type SedAddress =
  | number
  | "$"
  | { pattern: string }
  | StepAddress
  | RelativeOffset;

export interface AddressRange {
  start?: SedAddress;
  end?: SedAddress;
  negated?: boolean; // ! modifier - negate the address match
}

export type SedCommandType =
  | "substitute"
  | "print"
  | "printFirstLine" // P - print up to first newline
  | "delete"
  | "deleteFirstLine" // D - delete up to first newline
  | "append"
  | "insert"
  | "change"
  | "hold"
  | "holdAppend"
  | "get"
  | "getAppend"
  | "exchange"
  | "next"
  | "nextAppend"
  | "quit"
  | "quitSilent" // Q - quit without printing
  | "transliterate"
  | "lineNumber"
  | "branch"
  | "branchOnSubst"
  | "branchOnNoSubst" // T - branch if no substitution made
  | "label"
  | "zap" // z - zap/empty pattern space
  | "group" // { } - grouped commands
  | "list" // l - list pattern space with escapes
  | "printFilename" // F - print filename
  | "version" // v - version check
  | "readFile" // r - read file
  | "readFileLine" // R - read line from file
  | "writeFile" // w - write to file
  | "writeFirstLine" // W - write first line to file
  | "execute"; // e - execute command

export interface SubstituteCommand {
  type: "substitute";
  address?: AddressRange;
  pattern: string;
  replacement: string;
  global: boolean;
  ignoreCase: boolean;
  printOnMatch: boolean;
  nthOccurrence?: number; // Replace only Nth occurrence (1-based)
  extendedRegex?: boolean; // Use extended regex
}

export interface PrintCommand {
  type: "print";
  address?: AddressRange;
}

export interface DeleteCommand {
  type: "delete";
  address?: AddressRange;
}

export interface AppendCommand {
  type: "append";
  address?: AddressRange;
  text: string;
}

export interface InsertCommand {
  type: "insert";
  address?: AddressRange;
  text: string;
}

export interface ChangeCommand {
  type: "change";
  address?: AddressRange;
  text: string;
}

// Hold space commands
export interface HoldCommand {
  type: "hold"; // h - copy pattern space to hold space
  address?: AddressRange;
}

export interface HoldAppendCommand {
  type: "holdAppend"; // H - append pattern space to hold space
  address?: AddressRange;
}

export interface GetCommand {
  type: "get"; // g - copy hold space to pattern space
  address?: AddressRange;
}

export interface GetAppendCommand {
  type: "getAppend"; // G - append hold space to pattern space
  address?: AddressRange;
}

export interface ExchangeCommand {
  type: "exchange"; // x - exchange pattern and hold spaces
  address?: AddressRange;
}

export interface NextCommand {
  type: "next"; // n - print pattern space, read next line
  address?: AddressRange;
}

export interface QuitCommand {
  type: "quit"; // q - quit
  address?: AddressRange;
  exitCode?: number;
}

export interface QuitSilentCommand {
  type: "quitSilent"; // Q - quit without printing
  address?: AddressRange;
  exitCode?: number;
}

export interface NextAppendCommand {
  type: "nextAppend"; // N - append next line to pattern space
  address?: AddressRange;
}

export interface TransliterateCommand {
  type: "transliterate"; // y/src/dst/ - transliterate characters
  address?: AddressRange;
  source: string;
  dest: string;
}

export interface LineNumberCommand {
  type: "lineNumber"; // = - print line number
  address?: AddressRange;
}

export interface BranchCommand {
  type: "branch"; // b [label] - branch to label (or end)
  address?: AddressRange;
  label?: string;
}

export interface BranchOnSubstCommand {
  type: "branchOnSubst"; // t [label] - branch if substitution made
  address?: AddressRange;
  label?: string;
}

export interface LabelCommand {
  type: "label"; // :label - define a label
  name: string;
}

export interface BranchOnNoSubstCommand {
  type: "branchOnNoSubst"; // T [label] - branch if NO substitution made
  address?: AddressRange;
  label?: string;
}

export interface PrintFirstLineCommand {
  type: "printFirstLine"; // P - print up to first newline
  address?: AddressRange;
}

export interface DeleteFirstLineCommand {
  type: "deleteFirstLine"; // D - delete up to first newline, restart cycle
  address?: AddressRange;
}

export interface ZapCommand {
  type: "zap"; // z - empty/zap pattern space
  address?: AddressRange;
}

export interface GroupCommand {
  type: "group"; // { commands } - grouped commands
  address?: AddressRange;
  commands: SedCommand[];
}

export interface ListCommand {
  type: "list"; // l - list pattern space with escapes
  address?: AddressRange;
}

export interface PrintFilenameCommand {
  type: "printFilename"; // F - print current filename
  address?: AddressRange;
}

export interface VersionCommand {
  type: "version"; // v - check version
  address?: AddressRange;
  minVersion?: string;
}

export interface ReadFileCommand {
  type: "readFile"; // r - read file contents and append
  address?: AddressRange;
  filename: string;
}

export interface ReadFileLineCommand {
  type: "readFileLine"; // R - read single line from file
  address?: AddressRange;
  filename: string;
}

export interface WriteFileCommand {
  type: "writeFile"; // w - write pattern space to file
  address?: AddressRange;
  filename: string;
}

export interface WriteFirstLineCommand {
  type: "writeFirstLine"; // W - write first line to file
  address?: AddressRange;
  filename: string;
}

export interface ExecuteCommand {
  type: "execute"; // e - execute shell command (blocked in sandbox)
  address?: AddressRange;
  command?: string; // if undefined, execute pattern space
}

export type SedCommand =
  | SubstituteCommand
  | PrintCommand
  | PrintFirstLineCommand
  | DeleteCommand
  | DeleteFirstLineCommand
  | AppendCommand
  | InsertCommand
  | ChangeCommand
  | HoldCommand
  | HoldAppendCommand
  | GetCommand
  | GetAppendCommand
  | ExchangeCommand
  | NextCommand
  | QuitCommand
  | QuitSilentCommand
  | NextAppendCommand
  | TransliterateCommand
  | LineNumberCommand
  | BranchCommand
  | BranchOnSubstCommand
  | BranchOnNoSubstCommand
  | LabelCommand
  | ZapCommand
  | GroupCommand
  | ListCommand
  | PrintFilenameCommand
  | VersionCommand
  | ReadFileCommand
  | ReadFileLineCommand
  | WriteFileCommand
  | WriteFirstLineCommand
  | ExecuteCommand;

export interface SedState {
  patternSpace: string;
  holdSpace: string;
  lineNumber: number;
  totalLines: number;
  deleted: boolean;
  printed: boolean;
  quit: boolean;
  quitSilent: boolean; // For Q command: quit without printing
  exitCode?: number; // Exit code from q/Q command
  errorMessage?: string; // Error message (for v command, etc.)
  appendBuffer: string[]; // Lines to append after current line
  changedText?: string; // For c command: text to output in place of pattern space
  substitutionMade: boolean; // Track if substitution was made (for 't' command)
  lineNumberOutput: string[]; // Output from '=' command
  nCommandOutput: string[]; // Output from 'n' command (respects silent mode)
  restartCycle: boolean; // For D command: restart cycle without reading new line
  inDRestartedCycle: boolean; // Track if we're in a cycle restarted by D
  currentFilename?: string; // For F command
  // For file I/O commands (deferred execution)
  pendingFileReads: Array<{ filename: string; wholeFile: boolean }>;
  pendingFileWrites: Array<{ filename: string; content: string }>;
  // Range state tracking for pattern ranges like /start/,/end/
  rangeStates: Map<string, RangeState>;
  // Last used regex pattern for empty regex reuse (//)
  lastPattern?: string;
  // For cross-group branching: when a branch inside a group can't find its label
  branchRequest?: string;
  // Track total lines consumed during this execution cycle (for N command)
  linesConsumedInCycle: number;
}

// Range state tracking for pattern ranges like /start/,/end/
export interface RangeState {
  active: boolean;
  startLine?: number;
  completed?: boolean; // For numeric start ranges: once ended, don't reactivate
}

export interface SedExecutionLimits {
  maxIterations: number; // Max branch iterations per line (default: 10000)
  maxStringLength: number; // Max hold/pattern space size in bytes (0 = unlimited)
}
