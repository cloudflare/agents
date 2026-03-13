/**
 * Skip list for grep spec tests
 *
 * Tests in this list are expected to fail. If a test passes unexpectedly,
 * the test runner will report it as a failure so we know to remove it from the skip list.
 */

/**
 * Files to skip entirely
 */
const SKIP_FILES: Set<string> = new Set<string>([
  // Spencer test suites have different expectations from GNU grep
  // They test strict POSIX compliance which differs from RE2 behavior
  "gnu-spencer1.tests",
  "gnu-spencer2.tests"
]);

/**
 * Individual test skips within files
 * Format: "fileName:testName" -> skipReason
 */
const SKIP_TESTS: Map<string, string> = new Map<string, string>([
  // ============================================================
  // BusyBox tests
  // ============================================================
  // Tests that reference $0 or external state
  ["busybox-grep.tests:grep (exit success)", "references $0 script name"],
  // Word boundary with just ^ - RE2 handles differently
  [
    "busybox-grep.tests:grep -w ^ doesn't hang",
    "RE2 word boundary with bare anchor"
  ],

  // ============================================================
  // GNU BRE tests - RE2 differences
  // ============================================================
  // BRE: a\{1a\} - malformed brace (RE2 treats as literal)
  [
    'gnu-bre.tests:BRE: /a\\{1a\\}/ vs "BADBR"',
    "RE2 treats malformed BRE brace as literal"
  ],

  // ============================================================
  // GNU ERE tests - RE2 differences
  // ============================================================
  // Empty alternation in groups (|a), (a|) - RE2 allows
  [
    'gnu-ere.tests:ERE: /(|a)b/ vs "EMPTY" (NO ALTERNATION)',
    "RE2 allows empty alternation in groups"
  ],
  [
    'gnu-ere.tests:ERE: /(a|)b/ vs "EMPTY" (NO ALTERNATION)',
    "RE2 allows empty alternation in groups"
  ],
  // a{} - empty brace (RE2 allows)
  ['gnu-ere.tests:ERE: /a{}/ vs "BADBR"', "RE2 allows empty brace {}"],
  // a{1,x - malformed brace (RE2 treats as literal)
  [
    'gnu-ere.tests:ERE: /a{1,x/ vs "EBRACE" (TO CORRECT)',
    "RE2 treats malformed brace as literal"
  ],
  // a{300} - large repeat (RE2 has different limits)
  [
    'gnu-ere.tests:ERE: /a{300}/ vs "BADBR" (TO CORRECT)',
    "RE2 has different repeat count limits"
  ],
  // Multiple quantifiers a+?, a{1}? - RE2 treats as valid
  [
    'gnu-ere.tests:ERE: /a+?/ vs "BADRPT" (TO CORRECT)',
    "RE2 treats a+? as non-greedy"
  ],
  [
    'gnu-ere.tests:ERE: /a{1}?/ vs "BADRPT" (TO CORRECT)',
    "RE2 treats a{1}? as non-greedy"
  ],
  // Character range errors [1-3-5]
  [
    'gnu-ere.tests:ERE: /a[1-3-5]c/ vs "ERANGE" (TO CORRECT)',
    "RE2 handles multiple ranges differently"
  ],
  // POSIX collating elements
  [
    'gnu-ere.tests:ERE: /a[[.x.]/ vs "EBRACK" (TO CORRECT)',
    "RE2 handles incomplete collating element differently"
  ],
  [
    'gnu-ere.tests:ERE: /a[[.x,.]]/ vs "ECOLLATE" (TO CORRECT)',
    "POSIX collating elements not supported"
  ],
  [
    'gnu-ere.tests:ERE: /a[[.notdef.]]b/ vs "ECOLLATE" (TO CORRECT)',
    "POSIX collating elements not supported"
  ],
  // POSIX equivalence classes
  [
    'gnu-ere.tests:ERE: /a[[=b=]/ vs "EBRACK" (TO CORRECT)',
    "RE2 handles incomplete equivalence class differently"
  ],
  [
    'gnu-ere.tests:ERE: /a[[=b,=]]/ vs "ECOLLATE" (TO CORRECT)',
    "POSIX equivalence classes not supported"
  ],

  // Tests using - for stdin argument position
  ["busybox-grep.tests:grep - (specify stdin)", "- stdin arg not supported"],
  [
    "busybox-grep.tests:grep - infile (specify stdin and file)",
    "- stdin arg not supported"
  ],
  [
    "busybox-grep.tests:grep - nofile (specify stdin and nonexisting file)",
    "- stdin arg not supported"
  ],
  [
    "busybox-grep.tests:grep -q - nofile (specify stdin and nonexisting file, match)",
    "- stdin arg not supported"
  ],
  [
    "busybox-grep.tests:grep -s nofile - (stdin and nonexisting file, match)",
    "- stdin arg not supported"
  ],
  ["busybox-grep.tests:grep -L exitcode 0 #2", "- stdin arg not supported"],

  // Tests that create external files (>empty, mkdir)
  ["busybox-grep.tests:grep two files", "creates external empty file"],

  // -s option (suppress errors)
  [
    "busybox-grep.tests:grep -s nofile (nonexisting file, no match)",
    "-s option not implemented"
  ],

  // NUL byte handling with -a option
  ["busybox-grep.tests:grep handles NUL in files", "-a option / NUL handling"],
  ["busybox-grep.tests:grep handles NUL on stdin", "-a option / NUL handling"],

  // Multiple -e patterns
  [
    "busybox-grep.tests:grep handles multiple regexps",
    "multiple -e patterns not supported"
  ],
  [
    "busybox-grep.tests:grep -F handles multiple expessions",
    "multiple -e patterns not supported"
  ],
  [
    "busybox-grep.tests:grep -x -v -e EXP1 -e EXP2 finds nothing if either EXP matches",
    "multiple -e patterns not supported"
  ],

  // -f option (read patterns from file)
  [
    "busybox-grep.tests:grep can read regexps from stdin",
    "-f option not supported"
  ],

  // -L option (print files without matches)
  ["busybox-grep.tests:grep -L exitcode 0", "-L option not implemented"],

  // -o option (only matching) - edge cases
  [
    "busybox-grep.tests:grep -o does not loop forever",
    "-o option not implemented"
  ],

  // -v with -f on empty file
  ["busybox-grep.tests:grep -v -f EMPTY_FILE", "-f option not supported"],
  ["busybox-grep.tests:grep -vxf EMPTY_FILE", "-f option not supported"],

  // Newline-delimited patterns via command substitution
  [
    "busybox-grep.tests:grep PATTERN can be a newline-delimited list",
    "newline-delimited patterns not supported"
  ],
  [
    "busybox-grep.tests:grep -e PATTERN can be a newline-delimited list",
    "newline-delimited patterns not supported"
  ],

  // Recursive grep with symlinks (requires mkdir/symlink setup)
  [
    "busybox-grep.tests:grep -r on symlink to dir",
    "test requires external directory setup"
  ],
  [
    "busybox-grep.tests:grep -r on dir/symlink to dir",
    "test requires external directory setup"
  ]
]);

/**
 * Pattern-based skips for tests matching certain patterns
 *
 * NOTE: For GNU grep tests, prefer using # SKIP: comments directly in the
 * test files rather than adding patterns here.
 */
const SKIP_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  // ============================================================
  // BRE-specific: Incomplete brace expressions treated as literals by RE2
  // Tests expect EBRACE/BADBR errors, but RE2 treats as literal text
  // ============================================================
  // Incomplete BRE braces like a\{1 or a\{1a
  {
    pattern: /\/a\\{[0-9]+[^}\\]*\//,
    reason: "RE2 treats incomplete BRE brace as literal"
  },
  // BRE empty brace a\{\}
  {
    pattern: /\\{\\}/,
    reason: "RE2 treats BRE empty brace as literal"
  },
  // BRE brace with invalid content a\{1,x\}
  {
    pattern: /\\{[0-9]+,[a-z]+\\}/,
    reason: "RE2 treats BRE brace with invalid content as literal"
  },

  // ============================================================
  // ERE-specific: Patterns that RE2 handles differently
  // ============================================================
  // Empty brace quantifier a{} - RE2 allows, GNU rejects
  {
    pattern: /[a-z]\{\}\//,
    reason: "Empty brace quantifier {} handled differently by RE2"
  },
  // Malformed ERE braces like a{1,x - RE2 treats as literal
  {
    pattern: /\{[0-9]+,[a-z]/,
    reason: "RE2 treats malformed brace as literal"
  },
  // Multiple quantifiers like a+?, a*?, a{1}? - RE2 treats ? as optional quantifier
  {
    pattern: /[+*]\?\/|}\?\//,
    reason: "RE2 treats trailing ? as optional quantifier, not error"
  },

  // ============================================================
  // POSIX extensions not supported
  // ============================================================
  // POSIX collating elements [[.x.]] not supported
  {
    pattern: /\[\[\.[^\]]*\.\]\]/,
    reason: "POSIX collating elements [[.x.]] not supported"
  },
  // POSIX equivalence classes [[=x=]] not supported
  {
    pattern: /\[\[=[^\]]*=\]\]/,
    reason: "POSIX equivalence classes [[=x=]] not supported"
  },

  // ============================================================
  // Complex patterns handled differently
  // ============================================================
  // Character range errors like [1-3-5]
  {
    pattern: /\[[0-9]-[0-9]-[0-9]\]/,
    reason: "RE2 handles multiple ranges in brackets differently"
  },
  // a\x escape sequences (non-hex)
  {
    pattern: /\\x[^0-9a-fA-F/]/,
    reason: "RE2 handles \\x escape differently"
  }
];

/**
 * Get skip reason for a test
 */
export function getSkipReason(
  fileName: string,
  testName: string,
  command?: string
): string | undefined {
  // Check file-level skip first
  if (SKIP_FILES.has(fileName)) {
    return `File skipped: ${fileName}`;
  }

  // Check individual test skip (exact match)
  const key = `${fileName}:${testName}`;
  const exactMatch = SKIP_TESTS.get(key);
  if (exactMatch) {
    return exactMatch;
  }

  // Check pattern-based skips against test name
  for (const { pattern, reason } of SKIP_PATTERNS) {
    if (pattern.test(testName)) {
      return reason;
    }
  }

  // Check pattern-based skips against command content
  if (command) {
    for (const { pattern, reason } of SKIP_PATTERNS) {
      if (pattern.test(command)) {
        return reason;
      }
    }
  }

  return undefined;
}

/**
 * Check if entire file should be skipped
 */
export function isFileSkipped(fileName: string): boolean {
  return SKIP_FILES.has(fileName);
}
