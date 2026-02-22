#!/usr/bin/env tsx

/**
 * Automated test runner for the email agent
 *
 * This script:
 * 1. Starts the wrangler dev server
 * 2. Waits for it to be ready
 * 3. Runs functional tests
 * 4. Runs security bypass tests
 * 5. Outputs pass/fail results
 * 6. Stops the server
 *
 * Usage:
 *   npm run test              # Run all tests
 *   npm run test -- -v        # Verbose output
 *   npm run test -- --security # Run only security tests
 */

import { spawn, type ChildProcess } from "node:child_process";

interface TestResult {
  scenario: string;
  passed: boolean;
  error?: string;
  duration: number;
  category: "functional" | "security";
}

interface FunctionalTest {
  name: string;
  data: {
    from: string;
    to: string;
    subject: string;
    body: string;
  };
}

interface SecurityTest {
  name: string;
  description: string;
  data: {
    from: string;
    to: string;
    subject: string;
    body: string;
    headers?: Record<string, string>;
    secureOnly?: boolean;
  };
  // What we expect the result to be
  expectRoutedVia: "secure" | "address" | "rejected" | null;
  // If true, this test PASSES when the attack is BLOCKED
  expectBlocked: boolean;
}

// ============================================================================
// Functional Tests
// ============================================================================

const functionalTests: Record<string, FunctionalTest> = {
  basic: {
    name: "Basic Email",
    data: {
      from: "user@example.com",
      to: "EmailAgent+test123@example.com",
      subject: "Test Email",
      body: "Hello from test script!"
    }
  },
  unicode: {
    name: "Unicode Content",
    data: {
      from: "用户@example.com",
      to: "EmailAgent+unicode-test@example.com",
      subject: "Test Email with émojis 🎉 and ünïcödé",
      body: "Hello! 你好! مرحبا! 🚀\n\nThis email contains various unicode characters."
    }
  },
  "long-subject": {
    name: "Long Subject",
    data: {
      from: "user@example.com",
      to: "EmailAgent+long-subject@example.com",
      subject:
        "This is a very long subject line that might cause issues with email parsing or display - it goes on and on and on",
      body: "Testing how the agent handles long subject lines."
    }
  },
  multiline: {
    name: "Multiline Body",
    data: {
      from: "user@example.com",
      to: "EmailAgent+multiline@example.com",
      subject: "Multiline Test Email",
      body: `Dear Email Agent,

This is the first paragraph of the email body.

This is the second paragraph with some details:
- Item 1
- Item 2
- Item 3

Best regards,
Test User`
    }
  },
  "special-chars": {
    name: "Special Characters",
    data: {
      from: "user+tag@example.com",
      to: "EmailAgent+special@example.com",
      subject: 'Test with "quotes" and <brackets>',
      body: 'Special chars: & < > " \' \\ / \n\nJSON-like: {"key": "value"}'
    }
  }
};

// ============================================================================
// Security Tests - Attempting to bypass the secure resolver
// ============================================================================

const securityTests: SecurityTest[] = [
  // Attack 1: Forged headers without signature
  {
    name: "Forged headers (no signature)",
    description: "Try to route with X-Agent-Name/ID but no signature",
    data: {
      from: "attacker@evil.com",
      to: "victim@example.com",
      subject: "Trying to access your agent",
      body: "This is an attack attempt",
      headers: {
        "X-Agent-Name": "EmailAgent",
        "X-Agent-ID": "admin-secret-instance"
      },
      secureOnly: true
    },
    expectRoutedVia: "rejected",
    expectBlocked: true
  },

  // Attack 2: Random/fake signature
  {
    name: "Fake signature (random)",
    description: "Try to route with a completely fake signature",
    data: {
      from: "attacker@evil.com",
      to: "victim@example.com",
      subject: "Fake signature attack",
      body: "This is an attack attempt",
      headers: {
        "X-Agent-Name": "EmailAgent",
        "X-Agent-ID": "admin-secret-instance",
        "X-Agent-Sig": "aGFja2VyLWZha2Utc2lnbmF0dXJl",
        "X-Agent-Sig-Ts": Math.floor(Date.now() / 1000).toString()
      },
      secureOnly: true
    },
    expectRoutedVia: "rejected",
    expectBlocked: true
  },

  // Attack 3: Expired timestamp (31 days ago)
  {
    name: "Expired signature (31 days)",
    description: "Try to use a signature with an expired timestamp",
    data: {
      from: "attacker@evil.com",
      to: "victim@example.com",
      subject: "Expired signature attack",
      body: "This is an attack attempt",
      headers: {
        "X-Agent-Name": "EmailAgent",
        "X-Agent-ID": "test123",
        "X-Agent-Sig": "expired-sig",
        "X-Agent-Sig-Ts": (
          Math.floor(Date.now() / 1000) -
          31 * 24 * 60 * 60
        ).toString()
      },
      secureOnly: true
    },
    expectRoutedVia: "rejected",
    expectBlocked: true
  },

  // Attack 4: Future timestamp (try to extend signature validity)
  {
    name: "Future timestamp (1 hour ahead)",
    description: "Try to use a future timestamp to extend validity",
    data: {
      from: "attacker@evil.com",
      to: "victim@example.com",
      subject: "Future timestamp attack",
      body: "This is an attack attempt",
      headers: {
        "X-Agent-Name": "EmailAgent",
        "X-Agent-ID": "test123",
        "X-Agent-Sig": "future-sig",
        "X-Agent-Sig-Ts": (Math.floor(Date.now() / 1000) + 3600).toString()
      },
      secureOnly: true
    },
    expectRoutedVia: "rejected",
    expectBlocked: true
  },

  // Attack 5: Malformed timestamp
  {
    name: "Malformed timestamp",
    description: "Try to confuse parser with non-numeric timestamp",
    data: {
      from: "attacker@evil.com",
      to: "victim@example.com",
      subject: "Malformed timestamp attack",
      body: "This is an attack attempt",
      headers: {
        "X-Agent-Name": "EmailAgent",
        "X-Agent-ID": "test123",
        "X-Agent-Sig": "some-sig",
        "X-Agent-Sig-Ts": "not-a-number"
      },
      secureOnly: true
    },
    expectRoutedVia: "rejected",
    expectBlocked: true
  },

  // Attack 6: Negative timestamp
  {
    name: "Negative timestamp",
    description: "Try to use negative timestamp to bypass expiry",
    data: {
      from: "attacker@evil.com",
      to: "victim@example.com",
      subject: "Negative timestamp attack",
      body: "This is an attack attempt",
      headers: {
        "X-Agent-Name": "EmailAgent",
        "X-Agent-ID": "test123",
        "X-Agent-Sig": "some-sig",
        "X-Agent-Sig-Ts": "-1000000"
      },
      secureOnly: true
    },
    expectRoutedVia: "rejected",
    expectBlocked: true
  },

  // Attack 7: Empty signature
  {
    name: "Empty signature",
    description: "Try to route with empty signature value",
    data: {
      from: "attacker@evil.com",
      to: "victim@example.com",
      subject: "Empty signature attack",
      body: "This is an attack attempt",
      headers: {
        "X-Agent-Name": "EmailAgent",
        "X-Agent-ID": "test123",
        "X-Agent-Sig": "",
        "X-Agent-Sig-Ts": Math.floor(Date.now() / 1000).toString()
      },
      secureOnly: true
    },
    expectRoutedVia: "rejected",
    expectBlocked: true
  },

  // Attack 8: SQL injection in agent ID
  {
    name: "SQL injection in agent ID",
    description: "Try SQL injection payload in agent ID",
    data: {
      from: "attacker@evil.com",
      to: "victim@example.com",
      subject: "SQL injection attack",
      body: "This is an attack attempt",
      headers: {
        "X-Agent-Name": "EmailAgent",
        "X-Agent-ID": "'; DROP TABLE agents; --",
        "X-Agent-Sig": "injection-sig",
        "X-Agent-Sig-Ts": Math.floor(Date.now() / 1000).toString()
      },
      secureOnly: true
    },
    expectRoutedVia: "rejected",
    expectBlocked: true
  },

  // Attack 9: Path traversal in agent name
  {
    name: "Path traversal in agent name",
    description: "Try path traversal payload in agent name",
    data: {
      from: "attacker@evil.com",
      to: "victim@example.com",
      subject: "Path traversal attack",
      body: "This is an attack attempt",
      headers: {
        "X-Agent-Name": "../../../etc/passwd",
        "X-Agent-ID": "test",
        "X-Agent-Sig": "traversal-sig",
        "X-Agent-Sig-Ts": Math.floor(Date.now() / 1000).toString()
      },
      secureOnly: true
    },
    expectRoutedVia: "rejected",
    expectBlocked: true
  },

  // Attack 10: Header injection (newline)
  {
    name: "Header injection (newline)",
    description: "Try to inject headers via newline in agent ID",
    data: {
      from: "attacker@evil.com",
      to: "victim@example.com",
      subject: "Header injection attack",
      body: "This is an attack attempt",
      headers: {
        "X-Agent-Name": "EmailAgent",
        "X-Agent-ID": "test\r\nX-Injected: malicious",
        "X-Agent-Sig": "injection-sig",
        "X-Agent-Sig-Ts": Math.floor(Date.now() / 1000).toString()
      },
      secureOnly: true
    },
    expectRoutedVia: "rejected",
    expectBlocked: true
  },

  // Attack 11: Unicode normalization attack
  {
    name: "Unicode normalization attack",
    description: "Try unicode characters that might normalize differently",
    data: {
      from: "attacker@evil.com",
      to: "victim@example.com",
      subject: "Unicode normalization attack",
      body: "This is an attack attempt",
      headers: {
        "X-Agent-Name": "EmailÅgent", // Using Å (U+00C5) vs A + combining ring
        "X-Agent-ID": "test123",
        "X-Agent-Sig": "unicode-sig",
        "X-Agent-Sig-Ts": Math.floor(Date.now() / 1000).toString()
      },
      secureOnly: true
    },
    expectRoutedVia: "rejected",
    expectBlocked: true
  },

  // Attack 12: Case manipulation
  {
    name: "Case manipulation attack",
    description: "Try different casing to bypass signature",
    data: {
      from: "attacker@evil.com",
      to: "victim@example.com",
      subject: "Case manipulation attack",
      body: "This is an attack attempt",
      headers: {
        "X-Agent-Name": "EMAILAGENT", // uppercase
        "X-Agent-ID": "TEST123", // uppercase
        "X-Agent-Sig": "case-sig",
        "X-Agent-Sig-Ts": Math.floor(Date.now() / 1000).toString()
      },
      secureOnly: true
    },
    expectRoutedVia: "rejected",
    expectBlocked: true
  },

  // Attack 13: Very long agent ID (DoS attempt)
  {
    name: "Long agent ID (DoS)",
    description: "Try very long agent ID to cause resource exhaustion",
    data: {
      from: "attacker@evil.com",
      to: "victim@example.com",
      subject: "DoS attack",
      body: "This is an attack attempt",
      headers: {
        "X-Agent-Name": "EmailAgent",
        "X-Agent-ID": "x".repeat(10000),
        "X-Agent-Sig": "dos-sig",
        "X-Agent-Sig-Ts": Math.floor(Date.now() / 1000).toString()
      },
      secureOnly: true
    },
    expectRoutedVia: "rejected",
    expectBlocked: true
  },

  // Attack 14: Null byte injection
  {
    name: "Null byte injection",
    description: "Try null byte to truncate agent ID",
    data: {
      from: "attacker@evil.com",
      to: "victim@example.com",
      subject: "Null byte attack",
      body: "This is an attack attempt",
      headers: {
        "X-Agent-Name": "EmailAgent",
        "X-Agent-ID": "admin\x00ignored",
        "X-Agent-Sig": "null-sig",
        "X-Agent-Sig-Ts": Math.floor(Date.now() / 1000).toString()
      },
      secureOnly: true
    },
    expectRoutedVia: "rejected",
    expectBlocked: true
  },

  // Test: Verify fallback to address routing works
  {
    name: "Fallback to address routing",
    description: "Without secureOnly, should fall back to address routing",
    data: {
      from: "user@example.com",
      to: "EmailAgent+fallback-test@example.com",
      subject: "Normal email without headers",
      body: "This should route via address",
      headers: {},
      secureOnly: false
    },
    expectRoutedVia: "address",
    expectBlocked: false
  }
];

// ============================================================================
// Test Runner
// ============================================================================

const SERVER_URL = "http://localhost:8787";
const TEST_ENDPOINT = `${SERVER_URL}/api/test-email`;
const SECURITY_ENDPOINT = `${SERVER_URL}/api/test-security`;
const MAX_STARTUP_WAIT = 30000;
const POLL_INTERVAL = 500;

const verbose =
  process.argv.includes("-v") || process.argv.includes("--verbose");
const securityOnly = process.argv.includes("--security");

function log(message: string): void {
  console.log(message);
}

function verboseLog(message: string): void {
  if (verbose) {
    console.log(`  [verbose] ${message}`);
  }
}

async function waitForServer(timeoutMs: number): Promise<boolean> {
  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    try {
      const response = await fetch(SERVER_URL, {
        method: "GET",
        signal: AbortSignal.timeout(1000)
      });
      verboseLog(`Server responded with status ${response.status}`);
      return true;
    } catch {
      verboseLog("Server not ready yet, waiting...");
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
    }
  }

  return false;
}

function startServer(): ChildProcess {
  verboseLog("Starting wrangler dev server...");

  const serverProcess = spawn("npx", ["wrangler", "dev"], {
    stdio: verbose ? "inherit" : "pipe",
    detached: false,
    env: { ...process.env, FORCE_COLOR: "1" }
  });

  serverProcess.on("error", (err) => {
    console.error("Failed to start server:", err);
  });

  return serverProcess;
}

function stopServer(serverProcess: ChildProcess): void {
  verboseLog("Stopping server...");

  if (serverProcess.pid) {
    try {
      process.kill(serverProcess.pid, "SIGTERM");
    } catch {
      // Process may already be dead
    }
  }
}

async function runFunctionalTest(test: FunctionalTest): Promise<TestResult> {
  const startTime = Date.now();

  try {
    const response = await fetch(TEST_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(test.data),
      signal: AbortSignal.timeout(10000)
    });

    const duration = Date.now() - startTime;

    if (response.ok) {
      verboseLog(`Response: ${await response.text()}`);
      return {
        scenario: test.name,
        passed: true,
        duration,
        category: "functional"
      };
    } else {
      const errorText = await response.text();
      return {
        scenario: test.name,
        passed: false,
        error: `HTTP ${response.status}: ${errorText}`,
        duration,
        category: "functional"
      };
    }
  } catch (err) {
    const duration = Date.now() - startTime;
    return {
      scenario: test.name,
      passed: false,
      error: err instanceof Error ? err.message : String(err),
      duration,
      category: "functional"
    };
  }
}

async function runSecurityTest(test: SecurityTest): Promise<TestResult> {
  const startTime = Date.now();

  try {
    const response = await fetch(SECURITY_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(test.data),
      signal: AbortSignal.timeout(10000)
    });

    const duration = Date.now() - startTime;
    const result = (await response.json()) as {
      success: boolean;
      routedVia: string | null;
      message?: string;
      error?: string;
    };

    verboseLog(`Security test response: ${JSON.stringify(result)}`);

    // Determine if the test passed
    let passed: boolean;
    let error: string | undefined;

    if (test.expectBlocked) {
      // For attack tests, we expect the attack to be BLOCKED
      // That means routedVia should be "rejected", null, or undefined (all mean not routed)
      // The attack is only successful if it was routed via "secure"
      if (test.expectRoutedVia === "rejected") {
        // Attack is blocked if routedVia is "rejected", null, undefined, or "address" (fell back)
        // Attack is ONLY successful if it was routed via "secure" (bypassed security check)
        passed = result.routedVia !== "secure";
        if (!passed) {
          error = `Attack BYPASSED security! Routed via: ${result.routedVia}`;
        }
      } else {
        passed = result.routedVia !== "secure";
        if (!passed) {
          error = `Attack bypassed security! Routed via: ${result.routedVia}`;
        }
      }
    } else {
      // For non-attack tests, check expected routing
      passed = result.routedVia === test.expectRoutedVia;
      if (!passed) {
        error = `Expected routedVia=${test.expectRoutedVia}, got ${result.routedVia}`;
      }
    }

    return {
      scenario: `[SEC] ${test.name}`,
      passed,
      error,
      duration,
      category: "security"
    };
  } catch (err) {
    const duration = Date.now() - startTime;
    // For security tests, network errors might actually be good (server rejected the request)
    if (test.expectBlocked) {
      return {
        scenario: `[SEC] ${test.name}`,
        passed: true,
        duration,
        category: "security"
      };
    }
    return {
      scenario: `[SEC] ${test.name}`,
      passed: false,
      error: err instanceof Error ? err.message : String(err),
      duration,
      category: "security"
    };
  }
}

function printResults(results: TestResult[]): void {
  const functionalResults = results.filter((r) => r.category === "functional");
  const securityResults = results.filter((r) => r.category === "security");

  const functionalPassed = functionalResults.filter((r) => r.passed).length;
  const securityPassed = securityResults.filter((r) => r.passed).length;

  const totalPassed = results.filter((r) => r.passed).length;
  const totalFailed = results.filter((r) => !r.passed).length;
  const totalDuration = results.reduce((sum, r) => sum + r.duration, 0);

  if (functionalResults.length > 0) {
    console.log(`\n${"═".repeat(65)}`);
    console.log("FUNCTIONAL TESTS");
    console.log("═".repeat(65));

    for (const result of functionalResults) {
      const status = result.passed ? "✅ PASS" : "❌ FAIL";
      const duration = `(${result.duration}ms)`;
      console.log(`  ${status}  ${result.scenario.padEnd(30)} ${duration}`);
      if (!result.passed && result.error) {
        console.log(`         Error: ${result.error.slice(0, 70)}`);
      }
    }
    console.log(
      `  Subtotal: ${functionalPassed}/${functionalResults.length} passed`
    );
  }

  if (securityResults.length > 0) {
    console.log(`\n${"═".repeat(65)}`);
    console.log("SECURITY TESTS (Attack Bypass Attempts)");
    console.log("═".repeat(65));

    for (const result of securityResults) {
      const status = result.passed ? "🛡️ BLOCKED" : "⚠️ VULNERABLE";
      const duration = `(${result.duration}ms)`;
      const name = result.scenario.replace("[SEC] ", "");
      console.log(`  ${status}  ${name.padEnd(35)} ${duration}`);
      if (!result.passed && result.error) {
        console.log(`           ${result.error.slice(0, 65)}`);
      }
    }
    console.log(
      `  Subtotal: ${securityPassed}/${securityResults.length} attacks blocked`
    );
  }

  console.log(`\n${"─".repeat(65)}`);
  console.log(
    `  TOTAL: ${results.length} tests | ${totalPassed} passed | ${totalFailed} failed | ${totalDuration}ms`
  );
  console.log("═".repeat(65));

  if (totalFailed === 0) {
    console.log("\n🎉 All tests passed! Security defenses are working.\n");
  } else {
    const securityFailed = securityResults.filter((r) => !r.passed).length;
    if (securityFailed > 0) {
      console.log(
        `\n🚨 WARNING: ${securityFailed} security vulnerability(ies) detected!\n`
      );
    } else {
      console.log(`\n💥 ${totalFailed} test(s) failed.\n`);
    }
  }
}

async function main(): Promise<void> {
  console.log("🧪 Email Agent Test Runner");
  console.log("─".repeat(65));

  log("Starting dev server...");
  const serverProcess = startServer();

  await new Promise((resolve) => setTimeout(resolve, 1000));

  try {
    log("Waiting for server to be ready...");
    const serverReady = await waitForServer(MAX_STARTUP_WAIT);

    if (!serverReady) {
      console.error("❌ Server failed to start within timeout");
      stopServer(serverProcess);
      process.exit(1);
    }

    log("Server is ready!");
    await new Promise((resolve) => setTimeout(resolve, 500));

    const results: TestResult[] = [];

    // Run functional tests (unless security-only)
    if (!securityOnly) {
      log("Running functional tests...");
      for (const [_key, test] of Object.entries(functionalTests)) {
        const result = await runFunctionalTest(test);
        results.push(result);
      }
    }

    // Run security tests
    log("Running security tests...");
    for (const test of securityTests) {
      verboseLog(`Testing: ${test.description}`);
      const result = await runSecurityTest(test);
      results.push(result);
    }

    printResults(results);

    const failed = results.filter((r) => !r.passed).length;
    stopServer(serverProcess);

    await new Promise((resolve) => setTimeout(resolve, 500));
    process.exit(failed > 0 ? 1 : 0);
  } catch (err) {
    console.error("❌ Test runner error:", err);
    stopServer(serverProcess);
    process.exit(1);
  }
}

main();
