import { useAgent } from "agents/react";
import { useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type { StoredEvent } from "./github-types";
import type { RepoState } from "./server";
import "./styles.css";

// Event type icons and colors
const eventConfig: Record<
  string,
  { icon: string; color: string; label: string }
> = {
  push: { icon: "commit", color: "#2ea043", label: "Push" },
  pull_request: { icon: "git_pull_request", color: "#8957e5", label: "PR" },
  issues: { icon: "error_outline", color: "#f85149", label: "Issue" },
  issue_comment: {
    icon: "chat_bubble_outline",
    color: "#768390",
    label: "Comment"
  },
  star: { icon: "star", color: "#e3b341", label: "Star" },
  fork: { icon: "call_split", color: "#57ab5a", label: "Fork" },
  release: { icon: "local_offer", color: "#388bfd", label: "Release" },
  ping: { icon: "notifications", color: "#768390", label: "Ping" }
};

function formatTimeAgo(timestamp: string): string {
  const now = new Date();
  const then = new Date(timestamp);
  const diffMs = now.getTime() - then.getTime();
  const diffSecs = Math.floor(diffMs / 1000);
  const diffMins = Math.floor(diffSecs / 60);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffSecs < 60) return "just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return then.toLocaleDateString();
}

function EventCard({ event }: { event: StoredEvent }) {
  const config = eventConfig[event.type] || {
    icon: "help_outline",
    color: "#768390",
    label: event.type
  };

  return (
    <a
      href={event.url}
      target="_blank"
      rel="noopener noreferrer"
      className="event-card"
    >
      <div className="event-icon" style={{ backgroundColor: config.color }}>
        <span className="material-icons-round">{config.icon}</span>
      </div>
      <div className="event-content">
        <div className="event-header">
          <span className="event-type" style={{ color: config.color }}>
            {config.label}
            {event.action && ` (${event.action})`}
          </span>
          <span className="event-time">{formatTimeAgo(event.timestamp)}</span>
        </div>
        <div className="event-title">{event.title}</div>
        <div className="event-description">{event.description}</div>
        <div className="event-actor">
          {event.actor.avatar_url && (
            <img
              src={event.actor.avatar_url}
              alt={event.actor.login}
              className="actor-avatar"
            />
          )}
          <span className="actor-name">{event.actor.login}</span>
        </div>
      </div>
    </a>
  );
}

function StatsBar({ stats }: { stats: RepoState["stats"] }) {
  return (
    <div className="stats-bar">
      <div className="stat">
        <span className="material-icons-round" style={{ color: "#e3b341" }}>
          star
        </span>
        <span className="stat-value">{stats.stars.toLocaleString()}</span>
        <span className="stat-label">Stars</span>
      </div>
      <div className="stat">
        <span className="material-icons-round" style={{ color: "#57ab5a" }}>
          call_split
        </span>
        <span className="stat-value">{stats.forks.toLocaleString()}</span>
        <span className="stat-label">Forks</span>
      </div>
      <div className="stat">
        <span className="material-icons-round" style={{ color: "#f85149" }}>
          error_outline
        </span>
        <span className="stat-value">{stats.openIssues.toLocaleString()}</span>
        <span className="stat-label">Open Issues</span>
      </div>
    </div>
  );
}

function App() {
  const [repoInput, setRepoInput] = useState("cloudflare/agents");
  const [connectedRepo, setConnectedRepo] = useState<string | null>(null);
  const [agentName, setAgentName] = useState<string | null>(null);
  const [events, setEvents] = useState<StoredEvent[]>([]);
  const [repoState, setRepoState] = useState<RepoState | null>(null);
  const [isConnecting, setIsConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<string>("all");

  // Connect to the agent when agentName is set
  const agent = useAgent<RepoState>({
    agent: "repo-agent",
    name: agentName || undefined,
    onStateUpdate: (state) => {
      setRepoState(state);
    },
    onOpen: async () => {
      setIsConnecting(false);
      setError(null);
      // Fetch initial events
      try {
        const events = await agent.call<StoredEvent[]>("getEvents", [50]);
        setEvents(events);
      } catch (err) {
        console.error("Failed to fetch events:", err);
      }
    },
    onError: (err) => {
      setError(`Connection error: ${err}`);
      setIsConnecting(false);
    }
  });

  // Refresh events periodically
  useEffect(() => {
    if (!agentName) return;

    const interval = setInterval(async () => {
      try {
        const events = await agent.call<StoredEvent[]>("getEvents", [50]);
        setEvents(events);
      } catch (err) {
        console.error("Failed to refresh events:", err);
      }
    }, 10000); // Every 10 seconds

    return () => clearInterval(interval);
  }, [agentName, agent]);

  const handleConnect = useCallback(async () => {
    if (!repoInput.includes("/")) {
      setError("Please enter a valid repo name (owner/repo)");
      return;
    }

    setIsConnecting(true);
    setError(null);

    try {
      // Get the sanitized agent name
      const response = await fetch(
        `/api/agent-name?repo=${encodeURIComponent(repoInput)}`
      );
      const data = (await response.json()) as { agentName: string };
      setAgentName(data.agentName);
      setConnectedRepo(repoInput);
    } catch (err) {
      setError(`Failed to connect: ${err}`);
      setIsConnecting(false);
    }
  }, [repoInput]);

  const handleClearEvents = useCallback(async () => {
    try {
      await agent.call("clearEvents");
      setEvents([]);
    } catch (err) {
      console.error("Failed to clear events:", err);
    }
  }, [agent]);

  // Filter events
  const filteredEvents =
    filter === "all" ? events : events.filter((e) => e.type === filter);

  // Get unique event types for filter
  const eventTypes = Array.from(new Set(events.map((e) => e.type)));

  return (
    <div className="app">
      <header className="header">
        <h1>
          <span className="material-icons-round">webhook</span>
          GitHub Webhook Dashboard
        </h1>
        <p className="subtitle">Real-time repository activity monitor</p>
      </header>

      <div className="connect-section">
        <div className="connect-form">
          <input
            type="text"
            value={repoInput}
            onChange={(e) => setRepoInput(e.target.value)}
            placeholder="owner/repo (e.g., cloudflare/agents)"
            className="repo-input"
            onKeyDown={(e) => e.key === "Enter" && handleConnect()}
          />
          <button
            type="button"
            onClick={handleConnect}
            disabled={isConnecting}
            className="connect-button"
          >
            {isConnecting ? (
              <>
                <span className="material-icons-round spinning">sync</span>
                Connecting...
              </>
            ) : (
              <>
                <span className="material-icons-round">link</span>
                Connect
              </>
            )}
          </button>
        </div>

        {error && <div className="error-message">{error}</div>}

        {connectedRepo && (
          <div className="connected-info">
            <span className="material-icons-round">check_circle</span>
            Connected to <strong>{connectedRepo}</strong>
            {!repoState?.webhookConfigured && (
              <span className="waiting-badge">
                <span className="material-icons-round">hourglass_empty</span>
                Waiting for webhook events...
              </span>
            )}
          </div>
        )}
      </div>

      {repoState?.webhookConfigured && (
        <>
          <StatsBar stats={repoState.stats} />

          <div className="events-section">
            <div className="events-header">
              <h2>
                <span className="material-icons-round">history</span>
                Recent Events
              </h2>

              <div className="events-controls">
                <select
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                  className="filter-select"
                >
                  <option value="all">All Events</option>
                  {eventTypes.map((type) => (
                    <option key={type} value={type}>
                      {eventConfig[type]?.label || type}
                    </option>
                  ))}
                </select>

                <button
                  type="button"
                  onClick={handleClearEvents}
                  className="clear-button"
                  title="Clear all events"
                >
                  <span className="material-icons-round">delete_outline</span>
                </button>
              </div>
            </div>

            <div className="events-list">
              {filteredEvents.length === 0 ? (
                <div className="no-events">
                  <span className="material-icons-round">inbox</span>
                  <p>No events yet</p>
                  <p className="hint">
                    Events will appear here when webhooks are received
                  </p>
                </div>
              ) : (
                filteredEvents.map((event) => (
                  <EventCard key={event.id} event={event} />
                ))
              )}
            </div>
          </div>
        </>
      )}

      {!connectedRepo && (
        <div className="setup-guide">
          <h2>
            <span className="material-icons-round">settings</span>
            Setup Instructions
          </h2>
          <ol>
            <li>
              <strong>Deploy this worker</strong> to get your webhook URL
            </li>
            <li>
              Go to your GitHub repository → <strong>Settings</strong> →{" "}
              <strong>Webhooks</strong>
            </li>
            <li>
              Click <strong>Add webhook</strong>
            </li>
            <li>
              Set Payload URL to:{" "}
              <code>{window.location.origin}/webhooks/github/owner/repo</code>
            </li>
            <li>
              Set Content type to: <code>application/json</code>
            </li>
            <li>
              Set your webhook secret (must match{" "}
              <code>GITHUB_WEBHOOK_SECRET</code> in your worker)
            </li>
            <li>
              Select events you want to receive (or choose "Send me everything")
            </li>
            <li>Enter your repository name above and click Connect</li>
          </ol>
        </div>
      )}

      <footer className="footer">
        <p>
          Built with{" "}
          <a
            href="https://github.com/cloudflare/agents"
            target="_blank"
            rel="noopener noreferrer"
          >
            Cloudflare Agents
          </a>
        </p>
      </footer>
    </div>
  );
}

const root = createRoot(document.getElementById("root")!);
root.render(<App />);
