/**
 * Spec test runner - executes parsed spec tests against Bash
 */

import { Bash } from "../Shell";
import {
  getAcceptableStatuses,
  getAcceptableStderrs,
  getAcceptableStdouts,
  getExpectedStatus,
  getExpectedStderr,
  getExpectedStdout,
  isNotImplementedForBash,
  type ParsedSpecFile,
  type TestCase
} from "./parser";
import { testHelperCommands } from "./test-commands";

export interface TestResult {
  testCase: TestCase;
  passed: boolean;
  skipped: boolean;
  skipReason?: string;
  /** Test was expected to fail (## SKIP) but unexpectedly passed */
  unexpectedPass?: boolean;
  actualStdout?: string;
  actualStderr?: string;
  actualStatus?: number;
  expectedStdout?: string | null;
  expectedStderr?: string | null;
  expectedStatus?: number | null;
  error?: string;
  /** File path for the test file (used for UNEXPECTED PASS fix commands) */
  filePath?: string;
}

export interface RunOptions {
  /** Only run tests matching this pattern */
  filter?: RegExp;
  /** Custom Bash options */
  bashEnvOptions?: ConstructorParameters<typeof Bash>[0];
  /** File path for the test file */
  filePath?: string;
}

/**
 * Run a single test case
 */
export async function runTestCase(
  testCase: TestCase,
  options: RunOptions = {}
): Promise<TestResult> {
  // Track if test is expected to fail (## SKIP) - we'll still run it
  const expectedToFail = !!testCase.skip;
  const skipReason = testCase.skip;

  // These are true skips - we can't run these tests at all
  if (isNotImplementedForBash(testCase)) {
    return {
      testCase,
      passed: true,
      skipped: true,
      skipReason: "N-I (Not Implemented) for bash"
    };
  }

  // Skip empty scripts
  if (!testCase.script.trim()) {
    return {
      testCase,
      passed: true,
      skipped: true,
      skipReason: "Empty script"
    };
  }

  // Skip xtrace tests (set -x is accepted but trace output not implemented)
  if (requiresXtrace(testCase)) {
    return {
      testCase,
      passed: true,
      skipped: true,
      skipReason: "xtrace (set -x) trace output not implemented"
    };
  }

  // Create a fresh Bash for each test
  // Note: Don't use dotfiles here as they interfere with glob tests like "echo .*"
  const env = new Bash({
    files: {
      "/tmp/_keep": "",
      // Set up /dev/zero as a character device placeholder
      "/dev/zero": "",
      // Set up /bin directory
      "/bin/_keep": ""
    },
    cwd: "/tmp",
    env: {
      HOME: "/tmp",
      TMP: "/tmp",
      TMPDIR: "/tmp",
      SH: "bash" // For tests that check which shell is running
    },
    customCommands: testHelperCommands,
    ...options.bashEnvOptions
  });

  // Set up /tmp with sticky bit (mode 1777) for tests that check it
  await env.fs.chmod("/tmp", 0o1777);

  try {
    // Use rawScript to preserve leading whitespace for here-docs
    const result = await env.exec(testCase.script, { rawScript: true });

    const expectedStdout = getExpectedStdout(testCase);
    const expectedStderr = getExpectedStderr(testCase);
    const expectedStatus = getExpectedStatus(testCase);

    let passed = true;
    const errors: string[] = [];

    // Compare stdout
    // Use getAcceptableStdouts to handle OK variants (e.g., "## OK bash stdout-json: ...")
    const acceptableStdouts = getAcceptableStdouts(testCase);
    if (acceptableStdouts.length > 0) {
      const normalizedActual = normalizeOutput(result.stdout);
      const normalizedAcceptable = acceptableStdouts.map((s) =>
        normalizeOutput(s)
      );

      if (!normalizedAcceptable.includes(normalizedActual)) {
        passed = false;
        const stdoutDesc =
          normalizedAcceptable.length === 1
            ? JSON.stringify(normalizedAcceptable[0])
            : `one of [${normalizedAcceptable.map((s) => JSON.stringify(s)).join(", ")}]`;
        errors.push(
          `stdout mismatch:\n  expected: ${stdoutDesc}\n  actual:   ${JSON.stringify(normalizedActual)}`
        );
      }
    }

    // Compare stderr
    // Use getAcceptableStderrs to handle OK variants (e.g., "## OK bash STDERR: ...")
    const acceptableStderrs = getAcceptableStderrs(testCase);
    if (acceptableStderrs.length > 0) {
      const normalizedActual = normalizeOutput(result.stderr);
      const normalizedAcceptable = acceptableStderrs.map((s) =>
        normalizeOutput(s)
      );

      if (!normalizedAcceptable.includes(normalizedActual)) {
        passed = false;
        const stderrDesc =
          normalizedAcceptable.length === 1
            ? JSON.stringify(normalizedAcceptable[0])
            : `one of [${normalizedAcceptable.map((s) => JSON.stringify(s)).join(", ")}]`;
        errors.push(
          `stderr mismatch:\n  expected: ${stderrDesc}\n  actual:   ${JSON.stringify(normalizedActual)}`
        );
      }
    }

    // Compare exit status
    // Use getAcceptableStatuses to handle OK variants (e.g., "## OK bash status: 1")
    const acceptableStatuses = getAcceptableStatuses(testCase);
    if (acceptableStatuses.length > 0) {
      if (!acceptableStatuses.includes(result.exitCode)) {
        passed = false;
        const statusDesc =
          acceptableStatuses.length === 1
            ? String(acceptableStatuses[0])
            : `one of [${acceptableStatuses.join(", ")}]`;
        errors.push(
          `status mismatch: expected ${statusDesc}, got ${result.exitCode}`
        );
      }
    }

    // Handle ## SKIP tests: if expected to fail but actually passed, that's an unexpected pass
    if (expectedToFail) {
      if (passed) {
        // Test was expected to fail but passed - report as failure so we can unskip it
        // The SKIP marker is typically on the line after the test name
        const skipLineNumber = testCase.lineNumber + 1;
        const filePath = options.filePath || "<unknown>";
        return {
          testCase,
          passed: false,
          skipped: false,
          unexpectedPass: true,
          actualStdout: result.stdout,
          actualStderr: result.stderr,
          actualStatus: result.exitCode,
          expectedStdout,
          expectedStderr,
          expectedStatus,
          filePath,
          error: `FAIL because of UNEXPECTED PASS: This test was marked ## SKIP (${skipReason}) but now passes. Remove with: sed -i '' '${skipLineNumber}d' ${filePath}`
        };
      }
      // Test was expected to fail and did fail - that's fine, mark as skipped
      return {
        testCase,
        passed: true,
        skipped: true,
        skipReason: `## SKIP: ${skipReason}`,
        actualStdout: result.stdout,
        actualStderr: result.stderr,
        actualStatus: result.exitCode,
        expectedStdout,
        expectedStderr,
        expectedStatus
      };
    }

    return {
      testCase,
      passed,
      skipped: false,
      actualStdout: result.stdout,
      actualStderr: result.stderr,
      actualStatus: result.exitCode,
      expectedStdout,
      expectedStderr,
      expectedStatus,
      error: errors.length > 0 ? errors.join("\n") : undefined
    };
  } catch (e) {
    // If test was expected to fail and threw an error, that counts as expected failure
    if (expectedToFail) {
      return {
        testCase,
        passed: true,
        skipped: true,
        skipReason: `## SKIP: ${skipReason}`,
        error: `Execution error (expected): ${e instanceof Error ? e.message : String(e)}`
      };
    }
    return {
      testCase,
      passed: false,
      skipped: false,
      error: `Execution error: ${e instanceof Error ? e.message : String(e)}`
    };
  }
}

/**
 * Run all tests in a parsed spec file
 */
export async function runSpecFile(
  specFile: ParsedSpecFile,
  options: RunOptions = {}
): Promise<TestResult[]> {
  const results: TestResult[] = [];

  for (const testCase of specFile.testCases) {
    if (options.filter && !options.filter.test(testCase.name)) {
      continue;
    }

    const result = await runTestCase(testCase, options);
    results.push(result);
  }

  return results;
}

/**
 * Check if a test requires xtrace (set -x) trace output
 */
function requiresXtrace(testCase: TestCase): boolean {
  // Check if script uses set -x and expects trace output in stderr
  if (
    /\bset\s+-x\b/.test(testCase.script) ||
    /\bset\s+-o\s+xtrace\b/.test(testCase.script)
  ) {
    // Check if test expects xtrace-style output (lines starting with +)
    const expectedStderr = getExpectedStderr(testCase);
    if (expectedStderr && /^\+\s/m.test(expectedStderr)) {
      return true;
    }
  }
  return false;
}

/**
 * Normalize output for comparison
 * - Strip comment lines (starting with #) - these are metadata in spec test STDOUT sections
 * - Trim trailing whitespace from each line
 * - Ensure consistent line endings
 * - Trim trailing newline
 */
function normalizeOutput(output: string): string {
  return output
    .split("\n")
    .filter((line) => !line.startsWith("#")) // Strip comment lines
    .map((line) => line.trimEnd())
    .join("\n")
    .replace(/\n+$/, "");
}

/**
 * Get summary statistics for test results
 */
export function getResultsSummary(results: TestResult[]): {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
} {
  return {
    total: results.length,
    passed: results.filter((r) => r.passed && !r.skipped).length,
    failed: results.filter((r) => !r.passed).length,
    skipped: results.filter((r) => r.skipped).length
  };
}
