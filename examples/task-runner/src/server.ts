/**
 * Task Runner Example
 *
 * Demonstrates real AI-powered repository analysis using:
 * - Tasks for long-running operations
 * - OpenAI for architecture analysis
 * - GitHub API for repo data
 * - Real-time progress updates
 */

import {
  Agent,
  routeAgentRequest,
  callable,
  task,
  type TaskContext
} from "../../../packages/agents/src/index";
import OpenAI from "openai";

type Env = {
  TaskRunner: DurableObjectNamespace<TaskRunner>;
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
 * Task Runner Agent - Analyzes GitHub repositories using AI
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

  /**
   * Analyze a GitHub repository using AI
   *
   * The @task() decorator automatically:
   * - Wraps execution with progress tracking
   * - Persists task state to SQLite
   * - Broadcasts updates to connected clients
   * - Handles cancellation via ctx.signal
   *
   * Returns a TaskHandle immediately (doesn't wait for completion)
   */
  @task({ timeout: "5m" })
  async analyzeRepo(
    input: { repoUrl: string; branch?: string },
    ctx: TaskContext
  ): Promise<AnalysisResult> {
    const { repoUrl, branch = "main" } = input;

    // Parse GitHub URL
    const match = repoUrl.match(/github\.com\/([^\/]+)\/([^\/]+)/);
    if (!match) {
      throw new Error(
        "Invalid GitHub URL. Expected: https://github.com/owner/repo"
      );
    }
    const [, owner, repo] = match;
    const repoName = repo.replace(/\.git$/, "");

    // Phase 1: Fetch repository structure
    ctx.emit("phase", {
      name: "fetching",
      message: "Fetching repository structure..."
    });
    ctx.setProgress(10);

    if (ctx.signal.aborted) throw new Error("Aborted");

    const files = await this.fetchRepoTree(owner, repoName, branch);
    ctx.emit("files", {
      count: files.length,
      sample: files.slice(0, 10).map((f) => f.path)
    });
    ctx.setProgress(30);

    // Phase 2: Fetch key files (README, package.json, etc.)
    ctx.emit("phase", { name: "reading", message: "Reading key files..." });

    if (ctx.signal.aborted) throw new Error("Aborted");

    const keyFiles = await this.fetchKeyFiles(owner, repoName, branch, files);
    ctx.emit("keyFiles", { found: Object.keys(keyFiles) });
    ctx.setProgress(50);

    // Phase 3: AI Analysis
    ctx.emit("phase", {
      name: "analyzing",
      message: "AI analyzing architecture..."
    });

    if (ctx.signal.aborted) throw new Error("Aborted");

    const analysis = await this.analyzeWithAI(repoUrl, files, keyFiles, ctx);
    ctx.setProgress(90);

    // Complete
    ctx.emit("phase", { name: "complete", message: "Analysis complete!" });
    ctx.setProgress(100);

    return {
      repoUrl,
      branch,
      ...analysis,
      fileCount: files.length,
      analyzedAt: new Date().toISOString()
    };
  }

  /**
   * Fetch repository file tree from GitHub API
   */
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
      if (response.status === 404) {
        throw new Error(
          `Repository not found: ${owner}/${repo} (branch: ${branch})`
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
    }));
  }

  /**
   * Fetch content of key configuration files
   */
  private async fetchKeyFiles(
    owner: string,
    repo: string,
    branch: string,
    files: RepoFile[]
  ): Promise<Record<string, string>> {
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
          const content = await this.fetchFileContent(
            owner,
            repo,
            branch,
            file.path
          );
          if (content) {
            results[file.path] = content.slice(0, 5000); // Limit size
          }
        } catch {
          // Skip files we can't fetch
        }
      }
    }

    return results;
  }

  /**
   * Fetch a single file's content
   */
  private async fetchFileContent(
    owner: string,
    repo: string,
    branch: string,
    path: string
  ): Promise<string | null> {
    const url = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${path}`;

    const response = await fetch(url, {
      headers: { "User-Agent": "Agents-Task-Runner" }
    });

    if (!response.ok) return null;
    return response.text();
  }

  /**
   * Use OpenAI to analyze the repository
   */
  private async analyzeWithAI(
    repoUrl: string,
    files: RepoFile[],
    keyFiles: Record<string, string>,
    ctx: TaskContext
  ): Promise<{
    summary: string;
    architecture: string;
    techStack: string[];
    suggestions: string[];
  }> {
    const openai = this.getOpenAI();

    // Build context for the AI
    const fileList = files
      .filter((f) => f.type === "file")
      .map((f) => f.path)
      .slice(0, 200)
      .join("\n");

    const keyFilesContent = Object.entries(keyFiles)
      .map(([path, content]) => `--- ${path} ---\n${content}`)
      .join("\n\n");

    ctx.emit("ai", { message: "Sending to OpenAI for analysis..." });

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: `You are a senior software architect analyzing a repository. 
Provide a structured analysis in JSON format with these exact fields:
- summary: 2-3 sentence overview of what this project does
- architecture: Description of the project structure and patterns used
- techStack: Array of technologies/frameworks detected
- suggestions: Array of 2-3 improvement suggestions

Respond ONLY with valid JSON, no markdown.`
        },
        {
          role: "user",
          content: `Analyze this repository: ${repoUrl}

FILE STRUCTURE:
${fileList}

KEY FILES:
${keyFilesContent}`
        }
      ],
      temperature: 0.3,
      max_tokens: 1000
    });

    const responseText = completion.choices[0]?.message?.content || "{}";

    try {
      const parsed = JSON.parse(responseText);
      return {
        summary: parsed.summary || "Unable to generate summary",
        architecture: parsed.architecture || "Unable to analyze architecture",
        techStack: Array.isArray(parsed.techStack) ? parsed.techStack : [],
        suggestions: Array.isArray(parsed.suggestions) ? parsed.suggestions : []
      };
    } catch {
      // If JSON parsing fails, return the raw text as summary
      return {
        summary: responseText.slice(0, 500),
        architecture: "Unable to parse structured analysis",
        techStack: [],
        suggestions: []
      };
    }
  }

  /**
   * Get task status
   */
  @callable()
  getTask(taskId: string) {
    return this.tasks.get(taskId);
  }

  /**
   * Abort a running task
   */
  @callable()
  abortTask(taskId: string) {
    return this.tasks.cancel(taskId, "Cancelled by user");
  }

  /**
   * List all tasks
   */
  @callable()
  listTasks() {
    return this.tasks.list();
  }
}

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext) {
    return (
      (await routeAgentRequest(request, env)) ||
      new Response("Not found", { status: 404 })
    );
  }
} satisfies ExportedHandler<Env>;
