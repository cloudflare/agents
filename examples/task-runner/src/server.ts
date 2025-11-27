/**
 * Task Runner Example
 *
 * Demonstrates both task patterns:
 * 1. @task() - Quick operations running in the Agent (DO)
 * 2. workflow() - Long-running durable operations via Cloudflare Workflows
 *
 * Both use the same client API: agent.task("methodName", input)
 */

import {
  Agent,
  routeAgentRequest,
  callable,
  task,
  type TaskContext
} from "../../../packages/agents/src/index";
import OpenAI from "openai";

// Re-export the workflow for wrangler
export { AnalysisWorkflow } from "./workflows/analysis";

// Workflow type from cloudflare:workers
interface Workflow {
  create: (opts?: { params?: unknown }) => Promise<{ id: string }>;
  get: (id: string) => Promise<{ status: () => Promise<unknown> }>;
}

type Env = {
  "task-runner": DurableObjectNamespace<TaskRunner>;
  ANALYSIS_WORKFLOW: Workflow;
  OPENAI_API_KEY: string;
};

interface RepoFile {
  path: string;
  type: "file" | "dir";
  size?: number;
}

interface AnalysisResult {
  repoUrl: string;
  branch: string;
  summary: string;
  architecture: string;
  techStack: string[];
  suggestions: string[];
  fileCount: number;
  analyzedAt: string;
}

/**
 * Task Runner Agent
 *
 * Offers two analysis modes:
 * - Quick analysis: Uses @task(), runs in Agent, faster but limited duration
 * - Deep analysis: Uses Workflow, durable, can run for hours
 */
export class TaskRunner extends Agent<Env> {
  private openai: OpenAI | null = null;

  private getOpenAI(): OpenAI {
    if (!this.openai) {
      this.openai = new OpenAI({
        apiKey: this.env.OPENAI_API_KEY
      });
    }
    return this.openai;
  }

  // =========================================================================
  // Option 1: Quick Analysis with @task() (runs in Agent)
  // =========================================================================

  /**
   * Quick analysis using @task() decorator
   * - Runs in the Agent (Durable Object)
   * - Good for operations under ~30s
   * - Progress syncs in real-time
   */
  @task({ timeout: "5m" })
  async quickAnalysis(
    input: { repoUrl: string; branch?: string },
    ctx: TaskContext
  ): Promise<AnalysisResult> {
    const { repoUrl, branch = "main" } = input;

    const match = repoUrl.match(/github\.com\/([^\/]+)\/([^\/]+)/);
    if (!match) {
      throw new Error("Invalid GitHub URL");
    }
    const [, owner, repo] = match;
    const repoName = repo.replace(/\.git$/, "");

    ctx.emit("phase", { name: "fetching" });
    ctx.setProgress(10);

    if (ctx.signal.aborted) throw new Error("Aborted");

    const files = await this.fetchRepoTree(owner, repoName, branch);
    ctx.setProgress(30);

    ctx.emit("phase", { name: "reading" });
    const keyFiles = await this.fetchKeyFiles(owner, repoName, branch, files);
    ctx.setProgress(50);

    if (ctx.signal.aborted) throw new Error("Aborted");

    ctx.emit("phase", { name: "analyzing" });
    const analysis = await this.analyzeWithAI(repoUrl, files, keyFiles);
    ctx.setProgress(90);

    ctx.emit("phase", { name: "complete" });
    ctx.setProgress(100);

    return {
      repoUrl,
      branch,
      ...analysis,
      fileCount: files.length,
      analyzedAt: new Date().toISOString()
    };
  }

  // =========================================================================
  // Option 2: Deep Analysis with Workflow (durable)
  // =========================================================================

  /**
   * Deep analysis using Cloudflare Workflow
   * - Runs in Workflow engine (separate from DO)
   * - Can run for hours/days
   * - Survives restarts, automatic retries
   * - Same client API via this.workflow()!
   */
  @callable()
  async deepAnalysis(input: { repoUrl: string; branch?: string }) {
    return this.workflow<typeof input>("ANALYSIS_WORKFLOW", input);
  }

  // =========================================================================
  // Shared Helper Methods
  // =========================================================================

  private async fetchRepoTree(
    owner: string,
    repo: string,
    branch: string
  ): Promise<RepoFile[]> {
    const url = `https://api.github.com/repos/${owner}/${repo}/git/trees/${branch}?recursive=1`;
    const response = await fetch(url, {
      headers: {
        Accept: "application/vnd.github.v3+json",
        "User-Agent": "Agents-Task-Runner"
      }
    });

    if (!response.ok) {
      throw new Error(`GitHub API error: ${response.status}`);
    }

    const data = (await response.json()) as {
      tree: Array<{ path: string; type: string; size?: number }>;
    };

    return data.tree.map((item) => ({
      path: item.path,
      type: item.type === "blob" ? "file" : "dir",
      size: item.size
    }));
  }

  private async fetchKeyFiles(
    owner: string,
    repo: string,
    branch: string,
    files: RepoFile[]
  ): Promise<Record<string, string>> {
    const keyFileNames = [
      "README.md",
      "package.json",
      "Cargo.toml",
      "go.mod",
      "pyproject.toml"
    ];

    const results: Record<string, string> = {};

    for (const fileName of keyFileNames) {
      const file = files.find((f) => f.path === fileName);
      if (file && file.type === "file") {
        try {
          const url = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${file.path}`;
          const response = await fetch(url, {
            headers: { "User-Agent": "Agents-Task-Runner" }
          });
          if (response.ok) {
            results[file.path] = (await response.text()).slice(0, 5000);
          }
        } catch {
          // Skip
        }
      }
    }

    return results;
  }

  private async analyzeWithAI(
    repoUrl: string,
    files: RepoFile[],
    keyFiles: Record<string, string>
  ) {
    const openai = this.getOpenAI();

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
          content: `You are a senior software architect. Analyze the repository and respond with JSON:
{ "summary": "...", "architecture": "...", "techStack": [...], "suggestions": [...] }`
        },
        {
          role: "user",
          content: `Analyze: ${repoUrl}\n\nFILES:\n${fileList}\n\nKEY FILES:\n${keyFilesContent}`
        }
      ],
      temperature: 0.3,
      max_tokens: 1000
    });

    let text = completion.choices[0]?.message?.content || "{}";

    // Strip markdown code fences if present
    text = text
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/i, "")
      .trim();

    try {
      const parsed = JSON.parse(text);
      return {
        summary: parsed.summary || "Unable to generate summary",
        architecture: parsed.architecture || "Unable to analyze",
        techStack: Array.isArray(parsed.techStack) ? parsed.techStack : [],
        suggestions: Array.isArray(parsed.suggestions) ? parsed.suggestions : []
      };
    } catch {
      // Try to extract JSON from the response
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        try {
          const parsed = JSON.parse(jsonMatch[0]);
          return {
            summary: parsed.summary || text.slice(0, 500),
            architecture: parsed.architecture || "See summary",
            techStack: Array.isArray(parsed.techStack) ? parsed.techStack : [],
            suggestions: Array.isArray(parsed.suggestions)
              ? parsed.suggestions
              : []
          };
        } catch {
          // Fall through to fallback
        }
      }
      return {
        summary: text.slice(0, 500),
        architecture: "Unable to parse AI response",
        techStack: [],
        suggestions: []
      };
    }
  }

  // =========================================================================
  // Task Management (same for both @task and workflow)
  // =========================================================================

  @callable()
  getTask(taskId: string) {
    return this.tasks.get(taskId);
  }

  @callable()
  abortTask(taskId: string) {
    return this.tasks.cancel(taskId, "Cancelled by user");
  }

  @callable()
  listTasks() {
    return this.tasks.list();
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    return (
      (await routeAgentRequest(request, env, { ctx })) ||
      new Response("Not found", { status: 404 })
    );
  }
} satisfies ExportedHandler<Env>;
