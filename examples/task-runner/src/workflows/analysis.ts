/**
 * Deep Analysis Workflow
 *
 * A durable workflow demonstrating Cloudflare Workflows capabilities that are
 * IMPOSSIBLE in a regular Durable Object:
 *
 * 1. step.waitForEvent() - Pause for human approval (can wait hours/days)
 * 2. step.sleep() - Schedule future work (workflow hibernates, no compute cost)
 * 3. Multi-phase execution - Survives DO eviction, restarts, deploys
 * 4. Automatic retries - Exponential backoff on transient failures
 * 5. Long-running analysis - Can take minutes/hours without timeout
 *
 * Quick Analysis (in Agent): Single pass, ~30 seconds, no durability
 * Deep Analysis (this Workflow): Multi-phase, can pause for approval, scheduled follow-ups
 */

import {
  WorkflowEntrypoint,
  type WorkflowStep,
  type WorkflowEvent
} from "cloudflare:workers";
import OpenAI from "openai";

// Import the TaskRunner type for RPC calls
import type { TaskRunner } from "../server";

interface AnalysisParams {
  repoUrl: string;
  branch?: string;
  requireApproval?: boolean; // If true, pause for human approval on critical issues
  scheduleFollowUp?: boolean; // If true, schedule a follow-up analysis
  _agentBinding?: string;
  _agentName?: string;
}

interface RepoFile {
  path: string;
  type: "file" | "dir";
  size?: number;
}

interface SecurityIssue {
  severity: "low" | "medium" | "high" | "critical";
  file: string;
  description: string;
  recommendation: string;
}

interface AnalysisResult {
  repoUrl: string;
  branch: string;
  summary: string;
  architecture: string;
  techStack: string[];
  suggestions: string[];
  securityIssues: SecurityIssue[];
  codePatterns: string[];
  dependencies: { name: string; version: string; type: string }[];
  fileCount: number;
  analyzedFiles: number;
  analyzedAt: string;
  // Workflow-specific fields
  approvalStatus?: "pending" | "approved" | "rejected" | "auto-approved";
  approvedBy?: string;
  approvedAt?: string;
  followUpScheduled?: boolean;
  workflowDuration?: string;
}

type Env = {
  "task-runner": DurableObjectNamespace<TaskRunner>;
  OPENAI_API_KEY: string;
};

export class AnalysisWorkflow extends WorkflowEntrypoint<Env, AnalysisParams> {
  async run(
    event: WorkflowEvent<AnalysisParams>,
    step: WorkflowStep
  ): Promise<AnalysisResult> {
    const startTime = Date.now();
    const {
      repoUrl,
      branch = "main",
      requireApproval = true,
      scheduleFollowUp = false,
      _agentBinding,
      _agentName
    } = event.payload;

    const taskId = event.instanceId;

    /**
     * Notify agent of task updates via direct RPC call.
     */
    const notifyAgent = async (update: {
      event?: { type: string; data?: unknown };
      progress?: number;
      status?: "completed" | "failed";
      result?: AnalysisResult;
      error?: string;
    }) => {
      if (!_agentBinding || !_agentName) return;

      try {
        const agentNS = this.env["task-runner"];
        if (!agentNS) return;

        const agentId = agentNS.idFromName(_agentName);
        const agent = agentNS.get(agentId);
        await agent.handleWorkflowUpdate({ taskId, ...update });
      } catch (error) {
        console.error("[AnalysisWorkflow] Failed to notify agent:", error);
      }
    };

    const match = repoUrl.match(/github\.com\/([^/]+)\/([^/]+)/);
    if (!match) {
      throw new Error(
        "Invalid GitHub URL. Expected: https://github.com/owner/repo"
      );
    }
    const [, owner, repo] = match;
    const repoName = repo.replace(/\.git$/, "");

    // =========================================================================
    // PHASE 1: Data Collection (Steps 1-3)
    // Each step is checkpointed - if the workflow restarts, completed steps are skipped
    // =========================================================================

    const files = await step.do(
      "fetch-repo-tree",
      {
        retries: { limit: 3, delay: "5 seconds", backoff: "exponential" }
      },
      async () => {
        await notifyAgent({
          event: {
            type: "phase",
            data: {
              name: "fetching",
              message: "Fetching repository structure..."
            }
          },
          progress: 5
        });

        const url = `https://api.github.com/repos/${owner}/${repoName}/git/trees/${branch}?recursive=1`;
        const response = await fetch(url, {
          headers: {
            Accept: "application/vnd.github.v3+json",
            "User-Agent": "Agents-Task-Runner"
          }
        });

        if (!response.ok) {
          if (response.status === 404) {
            throw new Error(
              `Repository not found: ${owner}/${repoName} (branch: ${branch})`
            );
          }
          throw new Error(`GitHub API error: ${response.status}`);
        }

        const data = (await response.json()) as {
          tree: Array<{ path: string; type: string; size?: number }>;
        };

        return data.tree.map((item) => ({
          path: item.path,
          type: item.type === "blob" ? "file" : "dir",
          size: item.size
        })) as RepoFile[];
      }
    );

    await notifyAgent({
      event: { type: "files", data: { count: files.length } },
      progress: 10
    });

    const keyFiles = await step.do("fetch-key-files", async () => {
      await notifyAgent({
        event: {
          type: "phase",
          data: { name: "reading", message: "Reading configuration files..." }
        },
        progress: 15
      });

      const keyFileNames = [
        "README.md",
        "readme.md",
        "package.json",
        "Cargo.toml",
        "go.mod",
        "pyproject.toml",
        "requirements.txt",
        "wrangler.toml",
        "wrangler.jsonc",
        "tsconfig.json"
      ];

      const results: Record<string, string> = {};

      for (const fileName of keyFileNames) {
        const file = files.find(
          (f) => f.path === fileName || f.path.endsWith(`/${fileName}`)
        );
        if (file && file.type === "file") {
          try {
            const url = `https://raw.githubusercontent.com/${owner}/${repoName}/${branch}/${file.path}`;
            const response = await fetch(url, {
              headers: { "User-Agent": "Agents-Task-Runner" }
            });
            if (response.ok) {
              results[file.path] = (await response.text()).slice(0, 5000);
            }
          } catch {
            // Skip files we can't fetch
          }
        }
      }

      return results;
    });

    // Fetch source files for deep code analysis
    const sourceFiles = await step.do("fetch-source-files", async () => {
      await notifyAgent({
        event: {
          type: "phase",
          data: {
            name: "fetching-sources",
            message: "Fetching source files for deep analysis..."
          }
        },
        progress: 20
      });

      const sourceExtensions = [
        ".ts",
        ".tsx",
        ".js",
        ".jsx",
        ".py",
        ".go",
        ".rs"
      ];
      const sourceFileList = files
        .filter(
          (f) =>
            f.type === "file" &&
            sourceExtensions.some((ext) => f.path.endsWith(ext)) &&
            !f.path.includes("node_modules") &&
            !f.path.includes("dist/") &&
            !f.path.includes(".min.") &&
            (f.size || 0) < 50000
        )
        .slice(0, 20);

      const results: Record<string, string> = {};

      for (const file of sourceFileList) {
        try {
          const url = `https://raw.githubusercontent.com/${owner}/${repoName}/${branch}/${file.path}`;
          const response = await fetch(url, {
            headers: { "User-Agent": "Agents-Task-Runner" }
          });
          if (response.ok) {
            results[file.path] = (await response.text()).slice(0, 8000);
          }
        } catch {
          // Skip
        }
      }

      return results;
    });

    await notifyAgent({
      event: {
        type: "sourceFiles",
        data: { count: Object.keys(sourceFiles).length }
      },
      progress: 25
    });

    // =========================================================================
    // PHASE 2: AI Analysis (Steps 4-6)
    // Rate limiting with step.sleep() - workflow hibernates, no compute charges!
    // =========================================================================

    // Rate limit pause - WORKFLOW HIBERNATES here (impossible in a DO!)
    await step.sleep("rate-limit-pause-1", "3 seconds");

    const architectureAnalysis = await step.do(
      "architecture-analysis",
      {
        retries: { limit: 3, delay: "15 seconds", backoff: "exponential" },
        timeout: "5 minutes"
      },
      async () => {
        await notifyAgent({
          event: {
            type: "phase",
            data: { name: "analyzing", message: "AI analyzing architecture..." }
          },
          progress: 35
        });

        const openai = new OpenAI({ apiKey: this.env.OPENAI_API_KEY });

        const fileList = files
          .filter((f) => f.type === "file")
          .map((f) => f.path)
          .slice(0, 200)
          .join("\n");

        const keyFilesContent = Object.entries(keyFiles)
          .map(([path, content]) => `--- ${path} ---\n${content}`)
          .join("\n\n");

        const completion = await openai.chat.completions.create({
          model: "gpt-4o-mini",
          messages: [
            {
              role: "system",
              content: `You are a senior software architect. Analyze and return JSON:
{
  "summary": "2-3 sentence project overview",
  "architecture": "detailed architecture description with layers and data flow",
  "techStack": ["technology", "names"],
  "codePatterns": ["design patterns", "architectural patterns"],
  "suggestions": ["actionable", "improvements"]
}
Respond ONLY with valid JSON.`
            },
            {
              role: "user",
              content: `Analyze: ${repoUrl}\n\nFILES:\n${fileList}\n\nKEY FILES:\n${keyFilesContent}`
            }
          ],
          temperature: 0.3,
          max_tokens: 2000
        });

        const text = completion.choices[0]?.message?.content || "{}";
        try {
          const parsed = JSON.parse(
            text.replace(/^```json?\s*/i, "").replace(/```\s*$/i, "")
          );
          return {
            summary: parsed.summary || "Unable to generate summary",
            architecture: parsed.architecture || "Unable to analyze",
            techStack: Array.isArray(parsed.techStack) ? parsed.techStack : [],
            codePatterns: Array.isArray(parsed.codePatterns)
              ? parsed.codePatterns
              : [],
            suggestions: Array.isArray(parsed.suggestions)
              ? parsed.suggestions
              : []
          };
        } catch {
          return {
            summary: text.slice(0, 500),
            architecture: "Unable to parse",
            techStack: [],
            codePatterns: [],
            suggestions: []
          };
        }
      }
    );

    await notifyAgent({
      event: { type: "architectureComplete", data: {} },
      progress: 50
    });

    // Another rate limit pause
    await step.sleep("rate-limit-pause-2", "3 seconds");

    const securityAnalysis = await step.do(
      "security-analysis",
      {
        retries: { limit: 3, delay: "15 seconds", backoff: "exponential" },
        timeout: "5 minutes"
      },
      async () => {
        await notifyAgent({
          event: {
            type: "phase",
            data: {
              name: "security",
              message: "Scanning for security vulnerabilities..."
            }
          },
          progress: 60
        });

        const openai = new OpenAI({ apiKey: this.env.OPENAI_API_KEY });

        const sourceContent = Object.entries(sourceFiles)
          .slice(0, 10) // Analyze top 10 files
          .map(([path, content]) => `--- ${path} ---\n${content}`)
          .join("\n\n");

        const completion = await openai.chat.completions.create({
          model: "gpt-4o-mini",
          messages: [
            {
              role: "system",
              content: `You are a security auditor. Analyze for vulnerabilities. Return JSON:
{
  "issues": [
    {
      "severity": "low|medium|high|critical",
      "file": "path/to/file",
      "description": "vulnerability description",
      "recommendation": "fix recommendation"
    }
  ]
}
Look for: SQL injection, XSS, hardcoded secrets, insecure crypto, path traversal, etc.
If no issues, return {"issues": []}. Respond ONLY with valid JSON.`
            },
            {
              role: "user",
              content: `Security audit:\n\n${sourceContent || "No source files"}`
            }
          ],
          temperature: 0.2,
          max_tokens: 2000
        });

        const text = completion.choices[0]?.message?.content || "{}";
        try {
          const parsed = JSON.parse(
            text.replace(/^```json?\s*/i, "").replace(/```\s*$/i, "")
          );
          return {
            issues: Array.isArray(parsed.issues) ? parsed.issues : []
          };
        } catch {
          return { issues: [] };
        }
      }
    );

    const criticalIssues = securityAnalysis.issues.filter(
      (i: SecurityIssue) => i.severity === "critical" || i.severity === "high"
    );

    await notifyAgent({
      event: {
        type: "securityComplete",
        data: {
          total: securityAnalysis.issues.length,
          critical: criticalIssues.length
        }
      },
      progress: 70
    });

    // =========================================================================
    // PHASE 3: Human-in-the-Loop Approval (WORKFLOW-ONLY FEATURE!)
    // step.waitForEvent() pauses the workflow until an external event arrives
    // This can wait for HOURS or DAYS - impossible in a Durable Object!
    // =========================================================================

    let approvalStatus: "pending" | "approved" | "rejected" | "auto-approved" =
      "auto-approved";
    let approvedBy: string | undefined;
    let approvedAt: string | undefined;

    if (requireApproval && criticalIssues.length > 0) {
      await notifyAgent({
        event: {
          type: "phase",
          data: {
            name: "awaiting-approval",
            message: `Found ${criticalIssues.length} critical/high security issues. Waiting for human approval...`
          }
        },
        progress: 75
      });

      // WORKFLOW PAUSES HERE - can wait up to 7 days!
      // The workflow hibernates with zero compute cost until event arrives
      try {
        const approvalEvent = await step.waitForEvent<{
          approved: boolean;
          approver: string;
          comment?: string;
        }>("await-security-approval", {
          type: "security-approval",
          timeout: "7 days" // Can wait up to a week for approval!
        });

        // Access the payload from the event
        const payload = approvalEvent.payload;

        if (payload.approved) {
          approvalStatus = "approved";
          approvedBy = payload.approver;
          approvedAt = new Date().toISOString();

          await notifyAgent({
            event: {
              type: "phase",
              data: {
                name: "approved",
                message: `Approved by ${payload.approver}${payload.comment ? `: ${payload.comment}` : ""}`
              }
            },
            progress: 80
          });
        } else {
          approvalStatus = "rejected";
          approvedBy = payload.approver;

          // If rejected, we can still complete but mark it
          await notifyAgent({
            event: {
              type: "phase",
              data: {
                name: "rejected",
                message: `Rejected by ${payload.approver}. Analysis will complete but flagged.`
              }
            },
            progress: 80
          });
        }
      } catch {
        // Timeout - no approval received, auto-approve with warning
        approvalStatus = "auto-approved";
        await notifyAgent({
          event: {
            type: "phase",
            data: {
              name: "auto-approved",
              message:
                "No approval received within timeout. Auto-approving with warning."
            }
          },
          progress: 80
        });
      }
    }

    // =========================================================================
    // PHASE 4: Dependency Analysis
    // =========================================================================

    const dependencies = await step.do("parse-dependencies", async () => {
      await notifyAgent({
        event: {
          type: "phase",
          data: { name: "dependencies", message: "Parsing dependencies..." }
        },
        progress: 85
      });

      const deps: { name: string; version: string; type: string }[] = [];

      const packageJson = keyFiles["package.json"];
      if (packageJson) {
        try {
          const pkg = JSON.parse(packageJson);
          for (const [name, version] of Object.entries(
            pkg.dependencies || {}
          )) {
            deps.push({ name, version: String(version), type: "runtime" });
          }
          for (const [name, version] of Object.entries(
            pkg.devDependencies || {}
          )) {
            deps.push({ name, version: String(version), type: "dev" });
          }
        } catch {
          // Invalid JSON
        }
      }

      const cargoToml = keyFiles["Cargo.toml"];
      if (cargoToml) {
        const depMatch = cargoToml.match(/\[dependencies\]([\s\S]*?)(?:\[|$)/);
        if (depMatch) {
          const lines = depMatch[1].split("\n");
          for (const line of lines) {
            const m = line.match(/^(\S+)\s*=\s*"([^"]+)"/);
            if (m) {
              deps.push({ name: m[1], version: m[2], type: "runtime" });
            }
          }
        }
      }

      return deps;
    });

    // =========================================================================
    // PHASE 5: Schedule Follow-up (WORKFLOW-ONLY FEATURE!)
    // step.sleep() can pause for DAYS - workflow hibernates with no cost
    // =========================================================================

    let followUpScheduled = false;

    if (scheduleFollowUp) {
      // Schedule a follow-up notification in 24 hours
      // The workflow HIBERNATES here - no compute charges while sleeping!
      await notifyAgent({
        event: {
          type: "phase",
          data: {
            name: "scheduling",
            message: "Scheduling 24-hour follow-up reminder..."
          }
        },
        progress: 90
      });

      // In a real scenario, you'd sleep for "24 hours"
      // For demo purposes, we'll use a shorter duration
      await step.sleep("follow-up-delay", "10 seconds");

      await step.do("send-follow-up", async () => {
        await notifyAgent({
          event: {
            type: "follow-up",
            data: {
              message: `Follow-up reminder: Review the ${criticalIssues.length} security issues found in ${repoUrl}`
            }
          }
        });
      });

      followUpScheduled = true;
    }

    // =========================================================================
    // PHASE 6: Complete
    // =========================================================================

    const endTime = Date.now();
    const durationMs = endTime - startTime;
    const durationStr =
      durationMs > 60000
        ? `${Math.round(durationMs / 60000)} minutes`
        : `${Math.round(durationMs / 1000)} seconds`;

    const result: AnalysisResult = {
      repoUrl,
      branch,
      summary: architectureAnalysis.summary,
      architecture: architectureAnalysis.architecture,
      techStack: architectureAnalysis.techStack,
      codePatterns: architectureAnalysis.codePatterns,
      suggestions: architectureAnalysis.suggestions,
      securityIssues: securityAnalysis.issues,
      dependencies,
      fileCount: files.length,
      analyzedFiles: Object.keys(sourceFiles).length,
      analyzedAt: new Date().toISOString(),
      // Workflow-specific results
      approvalStatus,
      approvedBy,
      approvedAt,
      followUpScheduled,
      workflowDuration: durationStr
    };

    await step.do("notify-complete", async () => {
      await notifyAgent({
        event: {
          type: "phase",
          data: {
            name: "complete",
            message: `Deep analysis complete in ${durationStr}!`
          }
        },
        progress: 100,
        status: "completed",
        result
      });
    });

    return result;
  }
}
