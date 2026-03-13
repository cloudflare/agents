/**
 * Parser for Oils spec test format (.test.sh files)
 *
 * Format:
 * - File headers: `## key: value`
 * - Test cases start with: `#### Test Name`
 * - Assertions: `## stdout:`, `## status:`, `## STDOUT: ... ## END`
 * - Shell-specific: `## OK shell`, `## N-I shell`, `## BUG shell`
 */

export interface FileHeader {
  oilsFailuresAllowed?: number;
  compareShells?: string[];
  tags?: string[];
}

export interface Assertion {
  type: "stdout" | "stderr" | "status" | "stdout-json" | "stderr-json";
  value: string | number;
  shells?: string[]; // If specified, only applies to these shells
  variant?: "OK" | "N-I" | "BUG"; // Shell-specific variant type
}

export interface TestCase {
  name: string;
  script: string;
  assertions: Assertion[];
  lineNumber: number;
  skip?: string; // If set, test should be skipped (value is reason)
}

export interface ParsedSpecFile {
  header: FileHeader;
  testCases: TestCase[];
  filePath: string;
}

/**
 * Check if a shell name is bash-compatible (bash, bash-*, or just-bash)
 */
function isBashCompatible(s: string): boolean {
  return s === "bash" || s.startsWith("bash-") || s === "just-bash";
}

/**
 * Parse a spec test file content
 */
export function parseSpecFile(
  content: string,
  filePath: string
): ParsedSpecFile {
  const lines = content.split("\n");
  const header: FileHeader = {};
  const testCases: TestCase[] = [];

  let currentTest: TestCase | null = null;
  let scriptLines: string[] = [];
  let hasInlineCode = false; // True if ## code: directive was used
  let inMultiLineBlock = false;
  let multiLineType:
    | "stdout"
    | "stderr"
    | "stdout-json"
    | "stderr-json"
    | null = null;
  let multiLineContent: string[] = [];
  let multiLineShells: string[] | undefined;
  let multiLineVariant: "OK" | "N-I" | "BUG" | undefined;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNumber = i + 1;

    // Inside a multi-line block
    if (inMultiLineBlock) {
      // Handle both "## END" and "## END:" (with trailing colon)
      if (line === "## END" || line === "## END:") {
        // End of multi-line block
        if (currentTest && multiLineType) {
          currentTest.assertions.push({
            type: multiLineType,
            value: multiLineContent.join("\n"),
            shells: multiLineShells,
            variant: multiLineVariant
          });
        }
        inMultiLineBlock = false;
        multiLineType = null;
        multiLineContent = [];
        multiLineShells = undefined;
        multiLineVariant = undefined;
        continue;
      }
      // Check if another assertion is starting (ends current block without ## END)
      if (line.startsWith("## ") && isAssertionLine(line.slice(3))) {
        // End current block first
        if (currentTest && multiLineType) {
          currentTest.assertions.push({
            type: multiLineType,
            value: multiLineContent.join("\n"),
            shells: multiLineShells,
            variant: multiLineVariant
          });
        }
        inMultiLineBlock = false;
        multiLineType = null;
        multiLineContent = [];
        multiLineShells = undefined;
        multiLineVariant = undefined;
        // Don't continue - fall through to process this line as an assertion
      } else {
        multiLineContent.push(line);
        continue;
      }
    }

    // Test case header
    if (line.startsWith("#### ")) {
      // Save previous test case
      if (currentTest) {
        currentTest.script = scriptLines.join("\n").trim();
        if (currentTest.script || currentTest.assertions.length > 0) {
          testCases.push(currentTest);
        }
      }

      // Start new test case
      const name = line.slice(5).trim();
      currentTest = {
        name,
        script: "",
        assertions: [],
        lineNumber
      };
      scriptLines = [];
      hasInlineCode = false;
      continue;
    }

    // Assertion line (starts with ##)
    if (line.startsWith("## ")) {
      const assertionLine = line.slice(3);

      // File headers (before first test case)
      if (!currentTest) {
        parseHeaderLine(assertionLine, header);
        continue;
      }

      // Check for shell-specific variant prefix (BUG, BUG-2, OK, OK-2, N-I, etc.)
      const variantMatch = assertionLine.match(
        /^(OK(?:-\d+)?|N-I|BUG(?:-\d+)?)\s+([a-z0-9/.-]+)\s+(.+)$/i
      );
      if (variantMatch) {
        const variant = variantMatch[1] as "OK" | "N-I" | "BUG";
        const shells = variantMatch[2].split("/");
        const rest = variantMatch[3];

        // Check if it's a multi-line start (allow trailing whitespace)
        const multiLineMatch = rest.match(/^(STDOUT|STDERR):\s*$/);
        if (multiLineMatch) {
          inMultiLineBlock = true;
          multiLineType = multiLineMatch[1].toLowerCase() as
            | "stdout"
            | "stderr";
          multiLineContent = [];
          multiLineShells = shells;
          multiLineVariant = variant;
          continue;
        }

        // Single-line shell-specific assertion
        const assertion = parseSingleLineAssertion(rest);
        if (assertion) {
          assertion.shells = shells;
          assertion.variant = variant;
          currentTest.assertions.push(assertion);
        }
        continue;
      }

      // Check for multi-line block start (allow trailing whitespace)
      const multiLineStart = assertionLine.match(/^(STDOUT|STDERR):\s*$/);
      if (multiLineStart) {
        inMultiLineBlock = true;
        multiLineType = multiLineStart[1].toLowerCase() as "stdout" | "stderr";
        multiLineContent = [];
        continue;
      }

      // Check for SKIP directive
      // Supports both "## SKIP: reason" and "## SKIP (unimplementable): reason" formats
      const skipMatch = assertionLine.match(
        /^SKIP(?:\s*\([^)]+\))?(?::\s*(.*))?$/i
      );
      if (skipMatch) {
        currentTest.skip = skipMatch[1] || "skipped";
        continue;
      }

      // Check for code: directive (inline script)
      const codeMatch = assertionLine.match(/^code:\s*(.*)$/);
      if (codeMatch) {
        // Override any existing script lines with the inline code
        scriptLines = [codeMatch[1]];
        hasInlineCode = true; // Don't add any more script lines
        continue;
      }

      // Single-line assertion
      const assertion = parseSingleLineAssertion(assertionLine);
      if (assertion) {
        currentTest.assertions.push(assertion);
      }
      continue;
    }

    // Regular script line (only add if we're in a test case and no inline code was used)
    if (currentTest && !hasInlineCode) {
      scriptLines.push(line);
    }
  }

  // Save last test case
  if (currentTest) {
    currentTest.script = scriptLines.join("\n").trim();
    if (currentTest.script || currentTest.assertions.length > 0) {
      testCases.push(currentTest);
    }
  }

  return { header, testCases, filePath };
}

/**
 * Check if a line (without the ## prefix) is an assertion line
 */
function isAssertionLine(line: string): boolean {
  // Shell-specific variant (BUG, BUG-2, OK, OK-2, N-I, etc.)
  if (/^(OK(?:-\d+)?|N-I|BUG(?:-\d+)?)\s+[a-z0-9/.-]+\s+/i.test(line)) {
    return true;
  }
  // Multi-line block start (allow trailing whitespace)
  if (/^(STDOUT|STDERR):\s*$/.test(line)) {
    return true;
  }
  // Single-line assertions
  if (/^(stdout|stderr|status|stdout-json|stderr-json):/.test(line)) {
    return true;
  }
  return false;
}

function parseHeaderLine(line: string, header: FileHeader): void {
  const colonIndex = line.indexOf(":");
  if (colonIndex === -1) return;

  const key = line.slice(0, colonIndex).trim();
  const value = line.slice(colonIndex + 1).trim();

  switch (key) {
    case "oils_failures_allowed":
      header.oilsFailuresAllowed = parseInt(value, 10);
      break;
    case "compare_shells":
      header.compareShells = value.split(/\s+/);
      break;
    case "tags":
      header.tags = value.split(/\s+/);
      break;
  }
}

function parseSingleLineAssertion(line: string): Assertion | null {
  // stdout: value
  const stdoutMatch = line.match(/^stdout:\s*(.*)$/);
  if (stdoutMatch) {
    return { type: "stdout", value: stdoutMatch[1] };
  }

  // stderr: value
  const stderrMatch = line.match(/^stderr:\s*(.*)$/);
  if (stderrMatch) {
    return { type: "stderr", value: stderrMatch[1] };
  }

  // status: number
  const statusMatch = line.match(/^status:\s*(\d+)$/);
  if (statusMatch) {
    return { type: "status", value: parseInt(statusMatch[1], 10) };
  }

  // stdout-json: "value"
  const stdoutJsonMatch = line.match(/^stdout-json:\s*(.+)$/);
  if (stdoutJsonMatch) {
    try {
      const parsed = JSON.parse(stdoutJsonMatch[1]);
      return { type: "stdout-json", value: parsed };
    } catch {
      // If JSON parse fails, use raw value
      return { type: "stdout-json", value: stdoutJsonMatch[1] };
    }
  }

  // stderr-json: "value"
  const stderrJsonMatch = line.match(/^stderr-json:\s*(.+)$/);
  if (stderrJsonMatch) {
    try {
      const parsed = JSON.parse(stderrJsonMatch[1]);
      return { type: "stderr-json", value: parsed };
    } catch {
      return { type: "stderr-json", value: stderrJsonMatch[1] };
    }
  }

  return null;
}

/**
 * Get the expected stdout for a test case (considering bash-specific variants)
 */
export function getExpectedStdout(testCase: TestCase): string | null {
  // First, look for default stdout (correct behavior) - just-bash prefers correctness over bug-compatibility
  for (const assertion of testCase.assertions) {
    if (
      (assertion.type === "stdout" || assertion.type === "stdout-json") &&
      !assertion.shells
    ) {
      return String(assertion.value);
    }
  }

  // Fall back to bash-specific BUG assertions (when there's no default and only BUG bash exists)
  for (const assertion of testCase.assertions) {
    if (
      (assertion.type === "stdout" || assertion.type === "stdout-json") &&
      assertion.variant === "BUG" &&
      assertion.shells?.some(isBashCompatible)
    ) {
      return String(assertion.value);
    }
  }

  return null;
}

/**
 * Get the expected stderr for a test case
 */
export function getExpectedStderr(testCase: TestCase): string | null {
  // First, look for default stderr (correct behavior) - just-bash prefers correctness over bug-compatibility
  for (const assertion of testCase.assertions) {
    if (
      (assertion.type === "stderr" || assertion.type === "stderr-json") &&
      !assertion.shells
    ) {
      return String(assertion.value);
    }
  }

  // Fall back to bash-specific BUG assertions (when there's no default and only BUG bash exists)
  for (const assertion of testCase.assertions) {
    if (
      (assertion.type === "stderr" || assertion.type === "stderr-json") &&
      assertion.variant === "BUG" &&
      assertion.shells?.some(isBashCompatible)
    ) {
      return String(assertion.value);
    }
  }

  return null;
}

/**
 * Get the expected exit status for a test case
 * Returns the default expected status (ignoring OK variants which are alternates)
 */
export function getExpectedStatus(testCase: TestCase): number | null {
  // First, look for default status (correct behavior - just-bash prefers correctness)
  for (const assertion of testCase.assertions) {
    if (
      assertion.type === "status" &&
      !assertion.shells &&
      !assertion.variant
    ) {
      return assertion.value as number;
    }
  }

  // Fall back to bash-specific BUG status (when there's no default and only BUG bash exists)
  for (const assertion of testCase.assertions) {
    if (
      assertion.type === "status" &&
      assertion.variant === "BUG" &&
      assertion.shells?.some(isBashCompatible)
    ) {
      return assertion.value as number;
    }
  }

  return null;
}

/**
 * Get all acceptable stdout values for a test case
 * This includes the default stdout and any OK variants for bash
 */
export function getAcceptableStdouts(testCase: TestCase): string[] {
  const stdouts: string[] = [];

  // Add default stdout first (correct behavior - just-bash prefers correctness)
  for (const assertion of testCase.assertions) {
    if (
      (assertion.type === "stdout" || assertion.type === "stdout-json") &&
      !assertion.shells &&
      !assertion.variant
    ) {
      stdouts.push(String(assertion.value));
      break;
    }
  }

  // Add BUG bash stdout if present (also acceptable for bug-compatibility)
  for (const assertion of testCase.assertions) {
    if (
      (assertion.type === "stdout" || assertion.type === "stdout-json") &&
      assertion.variant === "BUG" &&
      assertion.shells?.some(isBashCompatible)
    ) {
      const value = String(assertion.value);
      if (!stdouts.includes(value)) {
        stdouts.push(value);
      }
    }
  }

  // Add OK bash stdouts (these are also acceptable)
  for (const assertion of testCase.assertions) {
    if (
      (assertion.type === "stdout" || assertion.type === "stdout-json") &&
      assertion.variant === "OK" &&
      assertion.shells?.some(isBashCompatible)
    ) {
      const value = String(assertion.value);
      if (!stdouts.includes(value)) {
        stdouts.push(value);
      }
    }
  }

  return stdouts;
}

/**
 * Get all acceptable stderr values for a test case
 * This includes the default stderr and any OK variants for bash
 */
export function getAcceptableStderrs(testCase: TestCase): string[] {
  const stderrs: string[] = [];

  // Add default stderr first (correct behavior - just-bash prefers correctness)
  for (const assertion of testCase.assertions) {
    if (
      (assertion.type === "stderr" || assertion.type === "stderr-json") &&
      !assertion.shells &&
      !assertion.variant
    ) {
      stderrs.push(String(assertion.value));
      break;
    }
  }

  // Add BUG bash stderr if present (also acceptable for bug-compatibility)
  for (const assertion of testCase.assertions) {
    if (
      (assertion.type === "stderr" || assertion.type === "stderr-json") &&
      assertion.variant === "BUG" &&
      assertion.shells?.some(isBashCompatible)
    ) {
      const value = String(assertion.value);
      if (!stderrs.includes(value)) {
        stderrs.push(value);
      }
    }
  }

  // Add OK bash stderrs (these are also acceptable)
  for (const assertion of testCase.assertions) {
    if (
      (assertion.type === "stderr" || assertion.type === "stderr-json") &&
      assertion.variant === "OK" &&
      assertion.shells?.some(isBashCompatible)
    ) {
      const value = String(assertion.value);
      if (!stderrs.includes(value)) {
        stderrs.push(value);
      }
    }
  }

  return stderrs;
}

/**
 * Get all acceptable exit statuses for a test case
 * This includes the default status and any OK variants for bash
 */
export function getAcceptableStatuses(testCase: TestCase): number[] {
  const statuses: number[] = [];

  // Add default status first (correct behavior - just-bash prefers correctness)
  let foundDefaultStatus = false;
  for (const assertion of testCase.assertions) {
    if (
      assertion.type === "status" &&
      !assertion.shells &&
      !assertion.variant
    ) {
      statuses.push(assertion.value as number);
      foundDefaultStatus = true;
      break;
    }
  }

  // Add BUG bash status if present (also acceptable for bug-compatibility)
  for (const assertion of testCase.assertions) {
    if (
      assertion.type === "status" &&
      assertion.variant === "BUG" &&
      assertion.shells?.some(isBashCompatible)
    ) {
      const value = assertion.value as number;
      if (!statuses.includes(value)) {
        statuses.push(value);
      }
    }
  }

  // Check if there are any OK or BUG bash status variants
  const hasOKBashStatus = testCase.assertions.some(
    (a) =>
      a.type === "status" &&
      a.variant === "OK" &&
      a.shells?.some(isBashCompatible)
  );
  const hasBUGBashStatus = testCase.assertions.some(
    (a) =>
      a.type === "status" &&
      a.variant === "BUG" &&
      a.shells?.some(isBashCompatible)
  );

  // If no explicit default status BUT there are OK or BUG bash status variants,
  // the implicit default is 0 (success). This matters because we want to
  // accept BOTH the implicit 0 AND the bash-specific status variants.
  // For BUG variants: if there's a BUG bash status but no default, the implicit
  // correct behavior is status 0, and we should accept that along with the buggy behavior.
  if (!foundDefaultStatus && (hasOKBashStatus || hasBUGBashStatus)) {
    if (!statuses.includes(0)) {
      statuses.push(0);
    }
  }

  // Add OK bash statuses (these are also acceptable)
  for (const assertion of testCase.assertions) {
    if (
      assertion.type === "status" &&
      assertion.variant === "OK" &&
      assertion.shells?.some(isBashCompatible)
    ) {
      const value = assertion.value as number;
      if (!statuses.includes(value)) {
        statuses.push(value);
      }
    }
  }

  return statuses;
}

/**
 * Check if a test case is marked as N-I (Not Implemented) for bash
 */
export function isNotImplementedForBash(testCase: TestCase): boolean {
  return testCase.assertions.some(
    (a) => a.variant === "N-I" && a.shells?.some(isBashCompatible)
  );
}
