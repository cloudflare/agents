/**
 * Email testing script - similar to playground/test-mail.ts
 * Tests email parsing and agent functionality locally
 */

import { createMimeMessage } from "mimetext";
import PostalMime from "postal-mime";

console.log("🧪 Testing Email Functionality...\n");

// Test 1: Basic email creation and parsing
console.log("=== Test 1: Email Creation and Parsing ===");

const msg = createMimeMessage();
msg.setSender({ addr: "user@example.com", name: "Test User" });
msg.setRecipient("agent+test123@example.com");
msg.setSubject("Test Email for Agent");
msg.addMessage({
  contentType: "text/plain",
  data: "Hello Email Agent! This is a test message to verify email routing works correctly.",
});

// Add routing headers
msg.setHeader("X-Agent-Name", "EmailAgent");
msg.setHeader("X-Agent-ID", "test123");
msg.setHeader("Message-ID", "<test123@example.com>");

const raw = msg.asRaw();
console.log("📧 Raw email created:");
console.log(raw);
console.log("");

// Test 2: Parse the email
console.log("=== Test 2: Email Parsing ===");
const parsed = await PostalMime.parse(raw);
console.log("📋 Parsed email structure:");
console.log(JSON.stringify({
  from: parsed.from,
  to: parsed.to,
  subject: parsed.subject,
  text: parsed.text,
  messageId: parsed.messageId,
  headers: Object.fromEntries(Object.entries(parsed.headers || {})),
}, null, 2));
console.log("");

// Test 3: Routing simulation
console.log("=== Test 3: Email Routing Simulation ===");

// Simulate address-based routing
function simulateAddressRouting(toAddress: string) {
  const emailMatch = toAddress.match(/^([^+@]+)(?:\+([^@]+))?@(.+)$/);
  if (!emailMatch) {
    return null;
  }
  
  const [, localPart, subAddress] = emailMatch;
  
  if (subAddress) {
    return {
      agentName: localPart,
      agentId: subAddress,
    };
  }
  
  return {
    agentName: localPart,
    agentId: "default",
  };
}

const routingResult = simulateAddressRouting("agent+test123@example.com");
console.log("🎯 Routing result:", routingResult);
console.log("");

// Test 4: Generate different email scenarios
console.log("=== Test 4: Email Scenarios ===");

const scenarios = [
  {
    name: "Customer Support",
    from: "customer@business.com",
    to: "support+urgent@example.com",
    subject: "Urgent: System Down",
    body: "Our system is down and we need immediate assistance!"
  },
  {
    name: "Auto-Reply Test", 
    from: "noreply@system.com",
    to: "agent@example.com",
    subject: "Auto-Reply: Your request received",
    body: "This is an automated response."
  },
  {
    name: "Newsletter",
    from: "newsletter@company.com", 
    to: "agent+newsletter@example.com",
    subject: "Weekly Newsletter #42",
    body: "Here's what's new this week..."
  }
];

for (const scenario of scenarios) {
  console.log(`📨 Scenario: ${scenario.name}`);
  
  const testMsg = createMimeMessage();
  testMsg.setSender({ addr: scenario.from });
  testMsg.setRecipient(scenario.to);
  testMsg.setSubject(scenario.subject);
  testMsg.addMessage({
    contentType: "text/plain",
    data: scenario.body,
  });
  
  const routing = simulateAddressRouting(scenario.to);
  
  console.log(`   From: ${scenario.from}`);
  console.log(`   To: ${scenario.to}`);
  console.log(`   Subject: ${scenario.subject}`);
  console.log(`   Routing: ${routing ? `${routing.agentName}:${routing.agentId}` : 'No routing'}`);
  console.log("");
}

// Test 5: API Testing URLs
console.log("=== Test 5: API Testing Instructions ===");
console.log("After deploying, you can test the agent with these URLs:");
console.log("");
console.log("📊 Get agent stats:");
console.log("   GET /api/stats/test123");
console.log("");
console.log("🔄 Toggle auto-reply:");
console.log("   POST /api/toggle-auto-reply/test123");
console.log("");
console.log("🧪 Send test email:");
console.log("   POST /api/test-email");
console.log("   Body: {");
console.log("     \"from\": \"user@example.com\",");
console.log("     \"to\": \"agent+test123@example.com\",");
console.log("     \"subject\": \"Test Email\",");
console.log("     \"body\": \"Hello from test!\"");
console.log("   }");
console.log("");
console.log("🗑️  Clear emails:");
console.log("   POST /api/clear/test123");
console.log("");

console.log("✅ Email testing complete!");
console.log("");
console.log("🚀 Next steps:");
console.log("1. Run 'npm run start' to start the development server");
console.log("2. Test the API endpoints with curl or a tool like Postman");
console.log("3. Deploy with 'npm run deploy' to test real email routing");
console.log("4. Configure your email DNS to route emails to your worker");