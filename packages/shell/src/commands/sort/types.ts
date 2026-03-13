// Types for sort command implementation

export interface KeySpec {
  // Start position
  startField: number; // 1-indexed field number
  startChar?: number; // 1-indexed character position within field

  // End position (optional)
  endField?: number; // 1-indexed field number
  endChar?: number; // 1-indexed character position within field

  // Per-key modifiers
  numeric?: boolean; // n - numeric sort
  reverse?: boolean; // r - reverse sort
  ignoreCase?: boolean; // f - fold case
  ignoreLeading?: boolean; // b - ignore leading blanks
  humanNumeric?: boolean; // h - human numeric sort
  versionSort?: boolean; // V - version sort
  dictionaryOrder?: boolean; // d - dictionary order
  monthSort?: boolean; // M - month sort
}

export interface SortOptions {
  reverse: boolean;
  numeric: boolean;
  unique: boolean;
  ignoreCase: boolean;
  humanNumeric: boolean;
  versionSort: boolean;
  dictionaryOrder: boolean;
  monthSort: boolean;
  ignoreLeadingBlanks: boolean;
  stable: boolean;
  checkOnly: boolean;
  outputFile: string | null;
  keys: KeySpec[];
  fieldDelimiter: string | null;
}
