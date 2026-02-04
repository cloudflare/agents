import { Agent, callable, getAgentByName, routeAgentRequest } from "agents";
import type {
  GitHubEventType,
  GitHubForkPayload,
  GitHubIssueCommentPayload,
  GitHubIssuesPayload,
  GitHubPingPayload,
  GitHubPullRequestPayload,
  GitHubPushPayload,
  GitHubReleasePayload,
  GitHubRepository,
  GitHubStarPayload,
  GitHubWebhookPayload,
  StoredEvent
} from "./github-types";

// State stored in memory (updated on each webhook)
export type RepoState = {
  repoFullName: string;
  stats: {
    stars: number;
    forks: number;
    openIssues: number;
  };
  lastUpdated: string | null;
  webhookConfigured: boolean;
};

export class RepoAgent extends Agent<Env, RepoState> {
  initialState: RepoState = {
    repoFullName: "",
    stats: {
      stars: 0,
      forks: 0,
      openIssues: 0
    },
    lastUpdated: null,
    webhookConfigured: false
  };

  async onStart(): Promise<void> {
    // Initialize the events table if it doesn't exist
    this.sql`
      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        action TEXT,
        title TEXT NOT NULL,
        description TEXT,
        url TEXT,
        actor_login TEXT,
        actor_avatar TEXT,
        timestamp TEXT NOT NULL
      )
    `;

    // Create index for faster queries
    this.sql`
      CREATE INDEX IF NOT EXISTS idx_events_timestamp ON events(timestamp DESC)
    `;
  }

  // Handle incoming webhook requests
  async onRequest(request: Request): Promise<Response> {
    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }

    // Get the event type from headers
    const eventType = request.headers.get("X-GitHub-Event") as GitHubEventType;
    if (!eventType) {
      return new Response("Missing X-GitHub-Event header", { status: 400 });
    }

    // Verify the signature
    const signature = request.headers.get("X-Hub-Signature-256");
    const body = await request.text();

    if (this.env.GITHUB_WEBHOOK_SECRET) {
      const isValid = await this.verifySignature(
        body,
        signature,
        this.env.GITHUB_WEBHOOK_SECRET
      );
      if (!isValid) {
        return new Response("Invalid signature", { status: 401 });
      }
    }

    // Parse and process the payload
    const payload = JSON.parse(body) as GitHubWebhookPayload;
    await this.processWebhook(eventType, payload);

    return new Response("OK", { status: 200 });
  }

  private async verifySignature(
    payload: string,
    signature: string | null,
    secret: string
  ): Promise<boolean> {
    if (!signature) return false;

    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );

    const signatureBytes = await crypto.subtle.sign(
      "HMAC",
      key,
      encoder.encode(payload)
    );

    const expectedSignature = `sha256=${Array.from(
      new Uint8Array(signatureBytes)
    )
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("")}`;

    return signature === expectedSignature;
  }

  private async processWebhook(
    eventType: GitHubEventType,
    payload: GitHubWebhookPayload
  ): Promise<void> {
    // Extract repository info
    const repo = this.getRepository(payload);
    if (!repo) return;

    // Update stats from repository data
    this.setState({
      ...this.state,
      repoFullName: repo.full_name,
      stats: {
        stars: repo.stargazers_count,
        forks: repo.forks_count,
        openIssues: repo.open_issues_count
      },
      lastUpdated: new Date().toISOString(),
      webhookConfigured: true
    });

    // Create and store the event
    const event = this.createEvent(eventType, payload);
    if (event) {
      this.sql`
        INSERT OR REPLACE INTO events (id, type, action, title, description, url, actor_login, actor_avatar, timestamp)
        VALUES (${event.id}, ${event.type}, ${event.action || null}, ${event.title}, ${event.description}, ${event.url}, ${event.actor.login}, ${event.actor.avatar_url}, ${event.timestamp})
      `;

      // Cleanup old events (keep last 100)
      this.sql`
        DELETE FROM events WHERE id NOT IN (
          SELECT id FROM events ORDER BY timestamp DESC LIMIT 100
        )
      `;
    }
  }

  private getRepository(
    payload: GitHubWebhookPayload
  ): GitHubRepository | null {
    if ("repository" in payload && payload.repository) {
      return payload.repository;
    }
    return null;
  }

  private createEvent(
    eventType: GitHubEventType,
    payload: GitHubWebhookPayload
  ): StoredEvent | null {
    const id = crypto.randomUUID();
    const timestamp = new Date().toISOString();

    switch (eventType) {
      case "ping": {
        const p = payload as GitHubPingPayload;
        return {
          id,
          type: "ping",
          title: "Webhook configured",
          description: p.zen,
          url: p.repository?.html_url || "",
          actor: {
            login: p.sender?.login || "github",
            avatar_url: p.sender?.avatar_url || ""
          },
          timestamp
        };
      }

      case "push": {
        const p = payload as GitHubPushPayload;
        const branch = p.ref.replace("refs/heads/", "");
        const commitCount = p.commits?.length || 0;
        return {
          id,
          type: "push",
          title: `Pushed ${commitCount} commit${commitCount !== 1 ? "s" : ""} to ${branch}`,
          description:
            p.commits?.[0]?.message?.split("\n")[0] || "No commit message",
          url: p.commits?.[0]?.url || p.repository.html_url,
          actor: {
            login: p.sender.login,
            avatar_url: p.sender.avatar_url
          },
          timestamp
        };
      }

      case "pull_request": {
        const p = payload as GitHubPullRequestPayload;
        return {
          id,
          type: "pull_request",
          action: p.action,
          title: `PR #${p.number}: ${p.pull_request.title}`,
          description: `${p.action} by ${p.sender.login}`,
          url: p.pull_request.html_url,
          actor: {
            login: p.sender.login,
            avatar_url: p.sender.avatar_url
          },
          timestamp
        };
      }

      case "issues": {
        const p = payload as GitHubIssuesPayload;
        return {
          id,
          type: "issues",
          action: p.action,
          title: `Issue #${p.issue.number}: ${p.issue.title}`,
          description: `${p.action} by ${p.sender.login}`,
          url: p.issue.html_url,
          actor: {
            login: p.sender.login,
            avatar_url: p.sender.avatar_url
          },
          timestamp
        };
      }

      case "issue_comment": {
        const p = payload as GitHubIssueCommentPayload;
        return {
          id,
          type: "issue_comment",
          action: p.action,
          title: `Comment on #${p.issue.number}`,
          description:
            p.comment.body.slice(0, 100) +
            (p.comment.body.length > 100 ? "..." : ""),
          url: p.comment.html_url,
          actor: {
            login: p.sender.login,
            avatar_url: p.sender.avatar_url
          },
          timestamp
        };
      }

      case "star": {
        const p = payload as GitHubStarPayload;
        return {
          id,
          type: "star",
          action: p.action,
          title: p.action === "created" ? "Repository starred" : "Star removed",
          description: `by ${p.sender.login}`,
          url: p.repository.html_url,
          actor: {
            login: p.sender.login,
            avatar_url: p.sender.avatar_url
          },
          timestamp
        };
      }

      case "fork": {
        const p = payload as GitHubForkPayload;
        return {
          id,
          type: "fork",
          title: "Repository forked",
          description: `Forked to ${p.forkee.full_name}`,
          url: p.forkee.html_url,
          actor: {
            login: p.sender.login,
            avatar_url: p.sender.avatar_url
          },
          timestamp
        };
      }

      case "release": {
        const p = payload as GitHubReleasePayload;
        return {
          id,
          type: "release",
          action: p.action,
          title: `Release ${p.release.tag_name}`,
          description: p.release.name || `${p.action} by ${p.sender.login}`,
          url: p.release.html_url,
          actor: {
            login: p.sender.login,
            avatar_url: p.sender.avatar_url
          },
          timestamp
        };
      }

      default:
        return null;
    }
  }

  @callable()
  getEvents(limit = 20): StoredEvent[] {
    const rows = [
      ...this.sql<{
        id: string;
        type: string;
        action: string | null;
        title: string;
        description: string;
        url: string;
        actor_login: string;
        actor_avatar: string;
        timestamp: string;
      }>`SELECT * FROM events ORDER BY timestamp DESC LIMIT ${limit}`
    ];

    return rows.map((row) => ({
      id: row.id,
      type: row.type as GitHubEventType,
      action: row.action || undefined,
      title: row.title,
      description: row.description,
      url: row.url,
      actor: {
        login: row.actor_login,
        avatar_url: row.actor_avatar
      },
      timestamp: row.timestamp
    }));
  }

  @callable()
  getStats(): RepoState["stats"] {
    return this.state.stats;
  }

  @callable()
  clearEvents(): void {
    this.sql`DELETE FROM events`;
    this.setState({
      ...this.state,
      lastUpdated: new Date().toISOString()
    });
  }
}

// Helper to sanitize repo name for use as agent name
function sanitizeRepoName(fullName: string): string {
  // Replace "/" with "-" and remove any other problematic characters
  return fullName
    .toLowerCase()
    .replace(/\//g, "-")
    .replace(/[^a-z0-9-]/g, "");
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Webhook endpoint: POST /webhooks/github/:owner/:repo
    if (
      url.pathname.startsWith("/webhooks/github/") &&
      request.method === "POST"
    ) {
      // Clone the request so we can read the body twice
      const clonedRequest = request.clone();
      const payload = (await clonedRequest.json()) as {
        repository?: { full_name?: string };
      };

      // Get repo name from payload
      const repoFullName = payload.repository?.full_name;
      if (!repoFullName) {
        return new Response("Missing repository in payload", { status: 400 });
      }

      // Get the agent for this specific repository
      const agentName = sanitizeRepoName(repoFullName);
      const agent = await getAgentByName(env.RepoAgent, agentName);

      // Forward the original request to the agent
      return agent.fetch(request);
    }

    // API endpoint to get agent name from repo name
    if (url.pathname === "/api/agent-name" && request.method === "GET") {
      const repo = url.searchParams.get("repo");
      if (!repo) {
        return new Response("Missing repo parameter", { status: 400 });
      }
      return new Response(
        JSON.stringify({ agentName: sanitizeRepoName(repo) }),
        {
          headers: { "Content-Type": "application/json" }
        }
      );
    }

    // Default agent routing for WebSocket connections
    return (
      (await routeAgentRequest(request, env)) ||
      new Response("Not found", { status: 404 })
    );
  }
} satisfies ExportedHandler<Env>;
