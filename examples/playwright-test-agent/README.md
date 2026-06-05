# Playwright Test Agent

Headless Think agents that accept JSON test cases, dispatch each test to a Playwright MCP-backed sub-agent for evidence collection, then let the parent agent decide pass or fail.

## Run

```bash
npm install
npm run dev
```

The example expects a Playwright MCP server reachable over HTTP/SSE. Pass it per request with `mcpServerUrl`, or set `PLAYWRIGHT_MCP_URL` in the Worker environment.

## Invoke

```bash
curl -X POST http://localhost:8787/run \
  -H 'content-type: application/json' \
  --data '{
    "planName": "playground",
    "baseUrl": "http://localhost:5173",
    "mcpServerUrl": "http://localhost:8931/mcp",
    "tests": [
      {
        "id": "home-page",
        "title": "Home page loads",
        "route": "/",
        "action": "Navigate to the home page",
        "expected": "The feature grid is visible"
      }
    ]
  }'
```

Request shape:

```ts
type TestCase = {
  id: string;
  title: string;
  suite?: string;
  route?: string;
  action?: string;
  expected?: string;
  steps?: string[];
  notes?: string;
};

type RunRequest = {
  tests: TestCase[];
  baseUrl?: string;
  planName?: string;
  mcpServerUrl?: string;
  maxConcurrency?: number;
};
```

Each sub-agent returns a structured envelope with free-form evidence and a deterministic replay script in a known field. It does not decide pass or fail.

```ts
type TestEvidence = {
  evidence: unknown;
  replayScript: string;
  trace?: unknown;
};
```

The parent agent adds a judgment:

```ts
type TestJudgment = {
  status: "pass" | "fail";
  summary: string;
  evidenceUsed: string[];
  failureReason?: string;
};
```

The response for each test includes both `evidence` from the sub-agent and `judgment` from the parent agent. The evidence contents can be unstructured, but the replay script is always at `evidence.replayScript`.

## Key Pattern

`TestPlanAgent` validates the JSON request, then calls `runAgentTool(PlaywrightTestAgent, ...)` once per test. `PlaywrightTestAgent` connects to the `playwright` MCP server, executes the browser steps, and collects evidence. `TestPlanAgent` reviews that evidence against the test case and records the pass/fail judgment.

Source layout:

- `src/schema.ts`: request/result schemas and shared types
- `src/test-plan-agent.ts`: root agent that fans out tests
- `src/playwright-test-agent.ts`: sub-agent that drives Playwright MCP
- `src/utils.ts`: result normalization, JSON parsing, hashing
- `src/server.ts`: HTTP entrypoint
