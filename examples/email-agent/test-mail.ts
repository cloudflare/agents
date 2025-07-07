#!/usr/bin/env tsx

// Simple test script for the email agent
async function testEmail() {
  const url = "http://localhost:8787/api/test-email";

  const testData = {
    from: "user@example.com",
    to: "agent+test123@example.com",
    subject: "Test Email",
    body: "Hello from test script!",
  };

  console.log("🧪 Testing email agent with:", testData);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(testData),
    });

    if (response.ok) {
      const result = await response.json();
      console.log("✅ Success:", result);
    } else {
      console.error("❌ Error:", response.status, response.statusText);
      const errorText = await response.text();
      console.error("Error details:", errorText);
    }
  } catch (error) {
    console.error("❌ Network error:", error);
    console.log("💡 Make sure the server is running with: npm run start");
  }
}

testEmail();
