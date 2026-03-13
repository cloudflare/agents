/**
 * RgOptions interface and default values
 */

export interface RgOptions {
  // Pattern matching
  ignoreCase: boolean;
  caseSensitive: boolean;
  smartCase: boolean;
  fixedStrings: boolean;
  wordRegexp: boolean;
  lineRegexp: boolean;
  invertMatch: boolean;
  multiline: boolean;
  multilineDotall: boolean;
  patterns: string[];
  patternFiles: string[];

  // Output control
  count: boolean;
  countMatches: boolean;
  files: boolean;
  filesWithMatches: boolean;
  filesWithoutMatch: boolean;
  stats: boolean;
  onlyMatching: boolean;
  maxCount: number;
  lineNumber: boolean;
  noFilename: boolean;
  withFilename: boolean;
  nullSeparator: boolean;
  byteOffset: boolean;
  column: boolean;
  vimgrep: boolean;
  replace: string | null;
  afterContext: number;
  beforeContext: number;
  contextSeparator: string;
  quiet: boolean;
  heading: boolean;
  passthru: boolean;
  includeZero: boolean;
  sort: "path" | "none";
  json: boolean;

  // File selection
  globs: string[];
  iglobs: string[]; // case-insensitive globs
  globCaseInsensitive: boolean; // make all globs case-insensitive
  types: string[];
  typesNot: string[];
  typeAdd: string[]; // runtime type additions (name:pattern)
  typeClear: string[]; // runtime type clearing
  hidden: boolean;
  noIgnore: boolean;
  noIgnoreDot: boolean;
  noIgnoreVcs: boolean;
  ignoreFiles: string[]; // custom ignore files via --ignore-file
  maxDepth: number;
  maxFilesize: number; // in bytes, 0 = unlimited
  followSymlinks: boolean;
  searchZip: boolean;
  searchBinary: boolean;
  preprocessor: string | null; // --pre command
  preprocessorGlobs: string[]; // --pre-glob patterns
}

export function createDefaultOptions(): RgOptions {
  return {
    ignoreCase: false,
    caseSensitive: false,
    smartCase: true,
    fixedStrings: false,
    wordRegexp: false,
    lineRegexp: false,
    invertMatch: false,
    multiline: false,
    multilineDotall: false,
    patterns: [],
    patternFiles: [],
    count: false,
    countMatches: false,
    files: false,
    filesWithMatches: false,
    filesWithoutMatch: false,
    stats: false,
    onlyMatching: false,
    maxCount: 0,
    lineNumber: true,
    noFilename: false,
    withFilename: false,
    nullSeparator: false,
    byteOffset: false,
    column: false,
    vimgrep: false,
    replace: null,
    afterContext: 0,
    beforeContext: 0,
    contextSeparator: "--",
    quiet: false,
    heading: false,
    passthru: false,
    includeZero: false,
    sort: "path",
    json: false,
    globs: [],
    iglobs: [],
    globCaseInsensitive: false,
    types: [],
    typesNot: [],
    typeAdd: [],
    typeClear: [],
    hidden: false,
    noIgnore: false,
    noIgnoreDot: false,
    noIgnoreVcs: false,
    ignoreFiles: [],
    maxDepth: 256,
    maxFilesize: 0,
    followSymlinks: false,
    searchZip: false,
    searchBinary: false,
    preprocessor: null,
    preprocessorGlobs: []
  };
}
