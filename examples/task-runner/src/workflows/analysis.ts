/**
 * Analysis Workflow
 *
 * A durable workflow that analyzes GitHub repositories using AI.
 * Extends WorkflowEntrypoint
 */

import {
  WorkflowEntrypoint,
  type WorkflowStep,
  type WorkflowEvent
} from "cloudflare:workers";
import OpenAI from "openai";

interface AnalysisParams {
  repoUrl: string;
  branch?: string;
  _taskId?: string;
  _agentBinding?: string;
  _agentName?: string;
}

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

type Env = {
  "task-runner": DurableObjectNamespace;
  OPENAI_API_KEY: string;
};

export class AnalysisWorkflow extends WorkflowEntrypoint<Env, AnalysisParams> {
  async run(
    event: WorkflowEvent<AnalysisParams>,
    step: WorkflowStep
  ): Promise<AnalysisResult> {
    const {
      repoUrl,
      branch = "main",
      _taskId,
      _agentBinding,
      _agentName
    } = event.payload;

    const notifyAgent = async (update: {
      event?: { type: string; data?: unknown };
      progress?: number;
      status?: "completed" | "failed";
      result?: unknown;
      error?: string;
    }) => {
      if (!_taskId || !_agentBinding || !_agentName) return;

      try {
        const agentNS = this.env[
          _agentBinding as keyof Env
        ] as DurableObjectNamespace;
        if (!agentNS) return;

        const agentId = agentNS.idFromName(_agentName);
        const agent = agentNS.get(agentId);

        await agent.fetch(
          new Request("http://internal/_workflow-update", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-partykit-namespace": _agentBinding,
              "x-partykit-room": _agentName
            },
            body: JSON.stringify({ taskId: _taskId, ...update })
          })
        );
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

    const files = await step.do("fetch-repo-tree", async () => {
      await notifyAgent({
        event: {
          type: "phase",
          data: {
            name: "fetching",
            message: "Fetching repository structure..."
          }
        },
        progress: 10
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
    });

    await notifyAgent({
      event: { type: "files", data: { count: files.length } },
      progress: 30
    });

    const keyFiles = await step.do("fetch-key-files", async () => {
      await notifyAgent({
        event: {
          type: "phase",
          data: { name: "reading", message: "Reading key files..." }
        },
        progress: 40
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
              const content = await response.text();
              results[file.path] = content.slice(0, 5000);
            }
          } catch {
            // Skip files we can't fetch
          }
        }
      }

      return results;
    });

    await notifyAgent({
      event: { type: "keyFiles", data: { found: Object.keys(keyFiles) } },
      progress: 50
    });

    const analysis = await step.do(
      "ai-analysis",
      {
        retries: {
          limit: 3,
          delay: "10 seconds",
          backoff: "exponential"
        },
        timeout: "5 minutes"
      },
      async () => {
        await notifyAgent({
          event: {
            type: "phase",
            data: { name: "analyzing", message: "AI analyzing architecture..." }
          },
          progress: 60
        });

        const openai = new OpenAI({
          apiKey: this.env.OPENAI_API_KEY
        });

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
            architecture:
              parsed.architecture || "Unable to analyze architecture",
            techStack: Array.isArray(parsed.techStack) ? parsed.techStack : [],
            suggestions: Array.isArray(parsed.suggestions)
              ? parsed.suggestions
              : []
          };
        } catch {
          return {
            summary: responseText.slice(0, 500),
            architecture: "Unable to parse structured analysis",
            techStack: [],
            suggestions: []
          };
        }
      }
    );

    const result: AnalysisResult = {
      repoUrl,
      branch,
      ...analysis,
      fileCount: files.length,
      analyzedAt: new Date().toISOString()
    };

    await step.do("notify-complete", async () => {
      await notifyAgent({
        event: {
          type: "phase",
          data: { name: "complete", message: "Analysis complete!" }
        },
        progress: 100,
        status: "completed",
        result
      });
    });

    return result;
  }
}
