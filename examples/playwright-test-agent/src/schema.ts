import { z } from "zod";
import type { RunAgentToolResult } from "agents";

export const testCaseSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  suite: z.string().optional(),
  route: z.string().optional(),
  action: z.string().optional(),
  expected: z.string().optional(),
  steps: z.array(z.string()).optional(),
  notes: z.string().optional()
});

export const testJudgmentSchema = z.object({
  status: z.enum(["pass", "fail"]),
  summary: z.string(),
  evidenceUsed: z.array(z.string()).default([]),
  failureReason: z.string().optional()
});

export const testEvidenceSchema = z.object({
  evidence: z.unknown(),
  replayScript: z.string(),
  trace: z.unknown().optional()
});

export const runRequestSchema = z.object({
  tests: z.array(testCaseSchema).min(1),
  baseUrl: z.string().optional(),
  planName: z.string().optional(),
  mcpServerUrl: z.string().optional(),
  maxConcurrency: z.number().int().positive().max(8).optional()
});

export type TestCase = z.infer<typeof testCaseSchema>;
export type TestEvidence = z.infer<typeof testEvidenceSchema>;
export type TestJudgment = z.infer<typeof testJudgmentSchema>;
export type RunRequest = z.infer<typeof runRequestSchema>;

export type TestInput = {
  test: TestCase;
  baseUrl?: string;
  planName?: string;
  mcpServerUrl?: string;
};

export type TestRunRecord = {
  test: TestCase;
  runId: string;
  agentType: string;
  agentStatus: RunAgentToolResult<TestEvidence>["status"];
  evidence: TestEvidence;
  judgment: TestJudgment;
};

export type TestPlanRunResult = {
  planId: string;
  attemptId: string;
  planName?: string;
  total: number;
  passed: number;
  failed: number;
  tests: TestRunRecord[];
};

export type Env = {
  AI: Ai;
  PLAYWRIGHT_MCP_URL?: string;
  TestPlanAgent: DurableObjectNamespace;
};
