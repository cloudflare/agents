#!/usr/bin/env tsx

/**
 * Test script for the email agent
 *
 * Usage:
 *   npm run test-email                    # Run all test scenarios
 *   npm run test-email -- --scenario basic    # Run specific scenario
 *   npm run test-email -- --id my-agent-id    # Use custom agent ID
 *   npm run test-email -- --url http://...    # Use custom server URL
 *   npm run test-email -- --help              # Show help
 */

interface TestScenario {
  name: string;
  description: string;
  data: {
    from: string;
    to: string;
    subject: string;
    body: string;
  };
}

const scenarios: Record<string, TestScenario> = {
  basic: {
    name: "Basic Email",
    description: "Simple test email with standard content",
    data: {
      from: "user@example.com",
      to: "EmailAgent+test123@example.com",
      subject: "Test Email",
      body: "Hello from test script!"
    }
  },
  unicode: {
    name: "Unicode Content",
    description: "Email with unicode characters and emojis",
    data: {
      from: "用户@example.com",
      to: "EmailAgent+unicode-test@example.com",
      subject: "Test Email with émojis 🎉 and ünïcödé",
      body: "Hello! 你好! مرحبا! 🚀\n\nThis email contains various unicode characters."
    }
  },
  "long-subject": {
    name: "Long Subject",
    description: "Email with an unusually long subject line",
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
    description: "Email with multiple paragraphs and formatting",
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
    description: "Email with special characters that might need escaping",
    data: {
      from: "user+tag@example.com",
      to: "EmailAgent+special@example.com",
      subject: 'Test with "quotes" and <brackets>',
      body: 'Special chars: & < > " \' \\ / \n\nJSON-like: {"key": "value"}'
    }
  }
};

function parseArgs(): {
  scenario?: string;
  id?: string;
  url: string;
  help: boolean;
  all: boolean;
} {
  const args = process.argv.slice(2);
  const result = {
    scenario: undefined as string | undefined,
    id: undefined as string | undefined,
    url: "http://localhost:8787/api/test-email",
    help: false,
    all: true
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") {
      result.help = true;
    } else if (arg === "--scenario" || arg === "-s") {
      result.scenario = args[++i];
      result.all = false;
    } else if (arg === "--id") {
      result.id = args[++i];
    } else if (arg === "--url") {
      result.url = args[++i];
    }
  }

  return result;
}

function showHelp(): void {
  console.log(`
Email Agent Test Script

Usage:
  npm run test-email                         Run all test scenarios
  npm run test-email -- --scenario <name>    Run specific scenario
  npm run test-email -- --id <agent-id>      Use custom agent ID
  npm run test-email -- --url <url>          Use custom server URL
  npm run test-email -- --help               Show this help

Available scenarios:
${Object.entries(scenarios)
  .map(([key, s]) => `  ${key.padEnd(15)} ${s.description}`)
  .join("\n")}

Examples:
  npm run test-email -- --scenario basic
  npm run test-email -- --scenario unicode --id my-custom-id
  npm run test-email -- --url http://my-worker.example.com/api/test-email
`);
}

async function sendTestEmail(
  url: string,
  data: TestScenario["data"],
  scenarioName: string
): Promise<boolean> {
  console.log(`\n📧 Running scenario: ${scenarioName}`);
  console.log(`   From: ${data.from}`);
  console.log(`   To: ${data.to}`);
  console.log(`   Subject: ${data.subject}`);
  console.log(
    `   Body: ${data.body.slice(0, 50)}${data.body.length > 50 ? "..." : ""}`
  );

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(data)
    });

    if (response.ok) {
      const result = await response.json();
      console.log("   ✅ Success:", result);
      return true;
    } else {
      console.error(`   ❌ Error: ${response.status} ${response.statusText}`);
      const errorText = await response.text();
      console.error("   Error details:", errorText);
      return false;
    }
  } catch (error) {
    console.error("   ❌ Network error:", error);
    return false;
  }
}

async function main(): Promise<void> {
  const args = parseArgs();

  if (args.help) {
    showHelp();
    process.exit(0);
  }

  console.log("🧪 Email Agent Test Script");
  console.log(`   Server URL: ${args.url}`);

  const scenariosToRun: [string, TestScenario][] = args.scenario
    ? [[args.scenario, scenarios[args.scenario]]]
    : Object.entries(scenarios);

  if (args.scenario && !scenarios[args.scenario]) {
    console.error(`❌ Unknown scenario: ${args.scenario}`);
    console.error(`   Available: ${Object.keys(scenarios).join(", ")}`);
    process.exit(1);
  }

  let passed = 0;
  let failed = 0;

  for (const [_key, scenario] of scenariosToRun) {
    const data = { ...scenario.data };

    // Apply custom agent ID if provided
    if (args.id) {
      const [localPart] = data.to.split("@");
      const [agentName] = localPart.split("+");
      data.to = `${agentName}+${args.id}@example.com`;
    }

    const success = await sendTestEmail(args.url, data, scenario.name);
    if (success) {
      passed++;
    } else {
      failed++;
    }
  }

  console.log(`\n📊 Results: ${passed} passed, ${failed} failed`);

  if (failed > 0) {
    console.log("\n💡 Make sure the server is running with: npm run start");
    process.exit(1);
  }
}

main();
