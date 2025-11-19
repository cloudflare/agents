# Documentation Sync Testing Utilities

The Agents SDK provides utilities for testing the automated documentation synchronization workflow. These tools help validate that changes to the SDK are properly reflected in the documentation.

## Overview

The documentation sync utilities are designed to test the integration between the `cloudflare/agents` repository and the `cloudflare/cloudflare-docs` repository. When changes are made to the SDK, these utilities can help verify that documentation updates are triggered correctly.

## Functions

### `testDocsSync()`

Tests the documentation sync workflow with configurable options.

**Signature:**

```typescript
function testDocsSync(options?: TestDocsSyncOptions): TestDocsSyncResult;
```

**Parameters:**

- `options` (optional): Configuration options for the test
  - `message` (string, optional): Custom message to include in the test result
  - `includeTimestamp` (boolean, optional): Whether to include a timestamp in the result

**Returns:**

- `TestDocsSyncResult`: Object containing test results
  - `success` (boolean): Whether the test succeeded
  - `message` (string): Description of the test result
  - `timestamp` (number, optional): Unix timestamp when the test was run (if `includeTimestamp` was true)

**Example:**

```typescript
import { testDocsSync } from "@cloudflare/agents";

// Basic usage
const result = testDocsSync();
console.log(result.message);
// Output: "Docs sync test successful: Default test"

// With custom options
const customResult = testDocsSync({
  message: "Testing PR #123",
  includeTimestamp: true
});
console.log(customResult.message);
// Output: "Docs sync test successful: Testing PR #123"
console.log(customResult.timestamp);
// Output: 1731974400000
```

### `validateDocsSyncBot()`

Validates that the documentation sync bot is configured and working correctly.

**Signature:**

```typescript
function validateDocsSyncBot(): boolean;
```

**Returns:**

- `boolean`: `true` if the bot validation passes, `false` otherwise

**Example:**

```typescript
import { validateDocsSyncBot } from "@cloudflare/agents";

if (validateDocsSyncBot()) {
  console.log("✅ Documentation sync bot is working correctly!");
} else {
  console.log("❌ Documentation sync bot validation failed");
}
```

## Use Cases

### CI/CD Integration

You can use these utilities in your CI/CD pipeline to verify documentation sync:

```typescript
import { testDocsSync, validateDocsSyncBot } from "@cloudflare/agents";

// Validate bot configuration
if (!validateDocsSyncBot()) {
  throw new Error("Docs sync bot is not configured correctly");
}

// Run test
const result = testDocsSync({
  message: `PR #${process.env.PR_NUMBER}`,
  includeTimestamp: true
});

console.log(`Test completed at ${new Date(result.timestamp)}`);
```

### Local Development

Use these utilities during local development to ensure your changes will trigger proper documentation updates:

```typescript
import { testDocsSync } from "@cloudflare/agents";

const result = testDocsSync({
  message: "Local development test"
});

if (result.success) {
  console.log("✅ Ready to commit - docs sync will work!");
}
```

## How It Works

These utilities are part of the automated documentation synchronization system that:

1. Detects changes to the Agents SDK
2. Triggers the documentation sync workflow
3. Creates or updates pull requests in `cloudflare/cloudflare-docs`
4. Maintains a comment on the source PR with a link to the docs PR

The test utilities validate that this workflow is functioning correctly.

## Related Documentation

- [Agent Class](./agent-class.md) - Core agent functionality
- [MCP Servers](./mcp-servers.md) - Model Context Protocol integration
- [Observability](./observability.md) - Monitoring and debugging
