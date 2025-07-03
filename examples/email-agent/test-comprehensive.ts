/**
 * Comprehensive email testing script
 * Tests both the simple API and the real email worker endpoint
 */


console.log("🧪 Comprehensive Email Agent Testing...\n");

// Test 1: Create a real email with proper headers
console.log("=== Test 1: Creating Real Email Format ===");

const createRealEmail = (
  from: string,
  to: string,
  subject: string,
  body: string
) => {
  const timestamp = new Date().toUTCString();
  const messageId = `<test-${Date.now()}@example.com>`;

  return `Received: from smtp.example.com (127.0.0.1) by cloudflare-email.com
From: "Test User" <${from}>
To: <${to}>
Subject: ${subject}
Date: ${timestamp}
Message-ID: ${messageId}
Content-Type: text/plain; charset=UTF-8
X-Agent-Name: EmailAgent
X-Agent-ID: test123

${body}`;
};

const realEmail = createRealEmail(
  "user@example.com",
  "agent+test123@example.com",
  "Comprehensive Test Email",
  "Hello Email Agent! This is a comprehensive test that simulates how emails actually arrive through Cloudflare Email Workers."
);

console.log("📧 Real email format:");
console.log(realEmail);
console.log("");

// Test 2: Generate curl commands
console.log("=== Test 2: Generated Test Commands ===");

console.log("📋 Copy and paste these commands to test your email agent:\n");

console.log("🔹 Test Simple API:");
console.log(`curl -X POST http://localhost:8787/api/test-email \\
  -H "Content-Type: application/json" \\
  -d '{
    "from": "user@example.com",
    "to": "agent+test123@example.com",
    "subject": "Simple API Test",
    "body": "Hello from simple API test!"
  }'`);
console.log("");

console.log("🔹 Test Real Email Worker (More Comprehensive):");
console.log(`curl --request POST 'http://localhost:8787/webhook/email' \\
  --url-query 'from=user@example.com' \\
  --url-query 'to=agent+test123@example.com' \\
  --header 'Content-Type: text/plain' \\
  --data-raw '${realEmail.replace(/'/g, "'\"'\"'")}'`);
console.log("");

console.log("🔹 Check Agent Stats:");
console.log("curl http://localhost:8787/api/stats/test123");
console.log("");

console.log("🔹 Toggle Auto-Reply:");
console.log("curl -X POST http://localhost:8787/api/toggle-auto-reply/test123");
console.log("");

console.log("🔹 Clear Email History:");
console.log("curl -X POST http://localhost:8787/api/clear/test123");
console.log("");

// Test 3: Different routing scenarios
console.log("=== Test 3: Email Routing Scenarios ===");

const scenarios = [
  {
    name: "Address-based routing with subaddress",
    to: "support+urgent@example.com",
    expectedAgent: "support",
    expectedId: "urgent",
  },
  {
    name: "Address-based routing without subaddress",
    to: "sales@example.com",
    expectedAgent: "sales",
    expectedId: "default",
  },
  {
    name: "Header-based routing",
    to: "any@example.com",
    headers: { "X-Agent-Name": "EmailAgent", "X-Agent-ID": "custom123" },
    expectedAgent: "EmailAgent",
    expectedId: "custom123",
  },
];

for (const scenario of scenarios) {
  console.log(`📨 ${scenario.name}:`);
  console.log(`   To: ${scenario.to}`);
  if (scenario.headers) {
    console.log(`   Headers: ${JSON.stringify(scenario.headers)}`);
  }
  console.log(
    `   Expected routing: ${scenario.expectedAgent}:${scenario.expectedId}`
  );

  // Generate real email for this scenario
  const scenarioEmail = createRealEmail(
    "test@example.com",
    scenario.to,
    `Test: ${scenario.name}`,
    `Testing ${scenario.name} routing scenario`
  );

  console.log(`   Test command:`);
  console.log(
    `   curl --request POST 'http://localhost:8787/webhook/email' \\`
  );
  console.log(`     --url-query 'from=test@example.com' \\`);
  console.log(`     --url-query 'to=${scenario.to}' \\`);
  console.log(`     --header 'Content-Type: text/plain' \\`);
  console.log(`     --data-raw '${scenarioEmail.split("\n")[0]}...'`);
  console.log("");
}

// Test 4: Email thread testing
console.log("=== Test 4: Email Thread Testing ===");

console.log("📧 Test email replies and threading:");
console.log("");

const originalMessageId = `<conversation-${Date.now()}@example.com>`;
console.log("🔹 Send initial email:");
console.log(`curl --request POST 'http://localhost:8787/webhook/email' \\
  --url-query 'from=customer@business.com' \\
  --url-query 'to=support+ticket123@example.com' \\
  --data-raw 'From: customer@business.com
To: support+ticket123@example.com  
Subject: Need Help
Message-ID: ${originalMessageId}

I need assistance with my account.'`);
console.log("");

console.log("🔹 Send reply (should route to same agent):");
console.log(`curl --request POST 'http://localhost:8787/webhook/email' \\
  --url-query 'from=customer@business.com' \\
  --url-query 'to=support@example.com' \\
  --data-raw 'From: customer@business.com
To: support@example.com
Subject: Re: Need Help  
References: ${originalMessageId}
In-Reply-To: ${originalMessageId}

Additional information about my issue.'`);
console.log("");

console.log("✅ Comprehensive testing setup complete!");
console.log("");
console.log("🚀 Testing workflow:");
console.log("1. Run 'npm run start' to start the development server");
console.log("2. Use the curl commands above to test different scenarios");
console.log("3. Check agent stats with the stats endpoint");
console.log("4. Verify auto-replies are working correctly");
console.log("5. Test email routing for different address patterns");
console.log("");
console.log("💡 The comprehensive tests use the real email worker endpoint");
console.log("   which more accurately simulates production email handling.");
