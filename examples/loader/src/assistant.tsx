import { useState } from "react";

// ── Mock Data ──────────────────────────────────────────────────────────

const MOCK_CONNECTIONS = [
  {
    id: "gmail",
    name: "Gmail",
    icon: "✉️",
    status: "connected" as const,
    detail: "sunil@example.com",
    color: "text-red-400"
  },
  {
    id: "calendar",
    name: "Google Calendar",
    icon: "📅",
    status: "connected" as const,
    detail: "3 upcoming events",
    color: "text-blue-400"
  },
  {
    id: "slack",
    name: "Slack",
    icon: "💬",
    status: "connected" as const,
    detail: "cloudflare.slack.com",
    color: "text-purple-400"
  },
  {
    id: "github",
    name: "GitHub",
    icon: "🐙",
    status: "connected" as const,
    detail: "sunilpai",
    color: "text-zinc-300"
  },
  {
    id: "linear",
    name: "Linear",
    icon: "📋",
    status: "available" as const,
    detail: "Click to connect",
    color: "text-indigo-400"
  },
  {
    id: "notion",
    name: "Notion",
    icon: "📝",
    status: "available" as const,
    detail: "Click to connect",
    color: "text-zinc-400"
  }
];

const MOCK_SKILLS = [
  {
    id: "email-triage",
    name: "Email Triage",
    description: "Categorize and summarize unread emails, draft replies",
    icon: "📧",
    enabled: true,
    trigger: "Runs every 30 min"
  },
  {
    id: "standup",
    name: "Daily Standup",
    description: "Compile yesterday's activity into a standup summary",
    icon: "📊",
    enabled: true,
    trigger: "Every weekday at 9am"
  },
  {
    id: "pr-review",
    name: "PR Reviewer",
    description: "Review open PRs, leave comments on code quality issues",
    icon: "🔍",
    enabled: true,
    trigger: "On new PR"
  },
  {
    id: "meeting-prep",
    name: "Meeting Prep",
    description: "Gather context and create briefings before meetings",
    icon: "🎯",
    enabled: false,
    trigger: "15 min before meetings"
  },
  {
    id: "weekly-digest",
    name: "Weekly Digest",
    description: "Summarize the week's activity across all connections",
    icon: "📰",
    enabled: false,
    trigger: "Every Friday at 4pm"
  },
  {
    id: "code-monitor",
    name: "Deployment Monitor",
    description: "Watch for failed deployments and alert with diagnosis",
    icon: "🚨",
    enabled: false,
    trigger: "On deploy failure"
  }
];

const MOCK_ACTIVITY = [
  {
    id: "1",
    time: "2 min ago",
    icon: "✉️",
    title: "Email triaged",
    detail: "Categorized 12 emails: 3 urgent, 5 FYI, 4 newsletters",
    type: "success" as const
  },
  {
    id: "2",
    time: "15 min ago",
    icon: "🔍",
    title: "PR review completed",
    detail: "Left 3 comments on cloudflare/agents#247",
    type: "success" as const
  },
  {
    id: "3",
    time: "1 hour ago",
    icon: "📅",
    title: "Meeting prep ready",
    detail: "Briefing for 'Q1 Planning' generated - 4 agenda items",
    type: "info" as const
  },
  {
    id: "4",
    time: "2 hours ago",
    icon: "💬",
    title: "Slack summary",
    detail: "3 threads need your attention in #agents-team",
    type: "warning" as const
  },
  {
    id: "5",
    time: "3 hours ago",
    icon: "📊",
    title: "Standup posted",
    detail: "Daily standup shared to #standup-engineering",
    type: "success" as const
  },
  {
    id: "6",
    time: "Yesterday",
    icon: "🚨",
    title: "Deploy alert",
    detail:
      "workers-agent-prod failed - OOM in handler. Auto-rollback triggered.",
    type: "error" as const
  }
];

const MOCK_MESSAGES = [
  {
    id: "1",
    role: "assistant" as const,
    content:
      "Good morning! Here's your daily briefing:\n\n**3 urgent emails** need your attention - one from the VP about the Q1 roadmap.\n\n**2 PRs** are waiting for your review.\n\nYour first meeting is **Q1 Planning** at 10am - I've prepared a briefing document.",
    time: "9:01 AM"
  },
  {
    id: "2",
    role: "user" as const,
    content: "Summarize the VP email and draft a response",
    time: "9:03 AM"
  },
  {
    id: "3",
    role: "assistant" as const,
    content:
      "**VP Email Summary:** Sarah is asking for updated timelines on the Agents SDK launch. She wants to know if we can hit the March 15 target and needs a risk assessment by EOD.\n\n**Draft reply:**\n\n> Hi Sarah, thanks for the heads up. The Agents SDK is on track for March 15. Main risk is the Durable Objects hibernation fix (ETA next week). I'll send a detailed risk assessment by 3pm today.\n\nShall I send this, or would you like to edit it?",
    time: "9:03 AM"
  },
  {
    id: "4",
    role: "user" as const,
    content:
      "Looks good, send it. Also remind me at 2pm to write that risk assessment.",
    time: "9:05 AM"
  },
  {
    id: "5",
    role: "assistant" as const,
    content:
      'Done! Email sent to Sarah.\n\nReminder set for **2:00 PM** - "Write risk assessment for Agents SDK launch".\n\nAnything else before your 10am meeting?',
    time: "9:05 AM"
  }
];

// ── Components ─────────────────────────────────────────────────────────

function ConnectionCard({
  connection
}: {
  connection: (typeof MOCK_CONNECTIONS)[0];
}) {
  return (
    <div
      className={`flex items-center gap-3 px-3 py-2.5 rounded-lg transition-colors ${
        connection.status === "connected"
          ? "bg-zinc-800/50 hover:bg-zinc-800"
          : "bg-zinc-900/50 hover:bg-zinc-800/50 opacity-60 cursor-pointer"
      }`}
    >
      <span className="text-lg">{connection.icon}</span>
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium text-zinc-200">
          {connection.name}
        </div>
        <div className="text-[11px] text-zinc-500 truncate">
          {connection.detail}
        </div>
      </div>
      {connection.status === "connected" ? (
        <span className="w-2 h-2 rounded-full bg-green-500 shrink-0" />
      ) : (
        <span className="text-[10px] text-zinc-600 font-medium">+ Add</span>
      )}
    </div>
  );
}

function SkillCard({ skill }: { skill: (typeof MOCK_SKILLS)[0] }) {
  const [enabled, setEnabled] = useState(skill.enabled);

  return (
    <div
      className={`p-3 rounded-lg border transition-colors ${
        enabled
          ? "bg-zinc-800/50 border-zinc-700/50"
          : "bg-zinc-900/30 border-zinc-800/30 opacity-50"
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="text-base">{skill.icon}</span>
          <div>
            <div className="text-sm font-medium text-zinc-200">
              {skill.name}
            </div>
            <div className="text-[11px] text-zinc-500 mt-0.5">
              {skill.description}
            </div>
          </div>
        </div>
        <button
          type="button"
          onClick={() => setEnabled(!enabled)}
          className={`relative w-9 h-5 rounded-full transition-colors shrink-0 mt-0.5 ${
            enabled ? "bg-blue-600" : "bg-zinc-700"
          }`}
        >
          <span
            className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
              enabled ? "left-[18px]" : "left-0.5"
            }`}
          />
        </button>
      </div>
      <div className="flex items-center gap-1.5 mt-2 ml-7">
        <span className="text-[10px] text-zinc-600">⏱</span>
        <span className="text-[10px] text-zinc-600">{skill.trigger}</span>
      </div>
    </div>
  );
}

function ActivityItem({ activity }: { activity: (typeof MOCK_ACTIVITY)[0] }) {
  const typeColors = {
    success: "border-green-600/30 bg-green-950/20",
    info: "border-blue-600/30 bg-blue-950/20",
    warning: "border-amber-600/30 bg-amber-950/20",
    error: "border-red-600/30 bg-red-950/20"
  };
  const dotColors = {
    success: "bg-green-500",
    info: "bg-blue-500",
    warning: "bg-amber-500",
    error: "bg-red-500"
  };

  return (
    <div
      className={`flex items-start gap-3 px-3 py-2.5 rounded-lg border ${typeColors[activity.type]}`}
    >
      <span className="text-sm mt-0.5">{activity.icon}</span>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-zinc-200">
            {activity.title}
          </span>
          <span
            className={`w-1.5 h-1.5 rounded-full ${dotColors[activity.type]}`}
          />
        </div>
        <div className="text-[11px] text-zinc-400 mt-0.5">
          {activity.detail}
        </div>
      </div>
      <span className="text-[10px] text-zinc-600 shrink-0 mt-0.5">
        {activity.time}
      </span>
    </div>
  );
}

function ChatMessage({ msg }: { msg: (typeof MOCK_MESSAGES)[0] }) {
  return (
    <div
      className={`px-4 py-3 ${
        msg.role === "user" ? "bg-zinc-900/30" : "border-b border-zinc-800/30"
      }`}
    >
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-[10px] font-medium uppercase tracking-wider text-zinc-500">
          {msg.role === "user" ? "You" : "Assistant"}
        </span>
        <span className="text-[10px] text-zinc-600">{msg.time}</span>
      </div>
      <div className="text-sm text-zinc-300 whitespace-pre-wrap leading-relaxed">
        {msg.content.split(/(\*\*.*?\*\*)/g).map((part) =>
          part.startsWith("**") && part.endsWith("**") ? (
            <strong key={part} className="text-zinc-100 font-semibold">
              {part.slice(2, -2)}
            </strong>
          ) : part.startsWith(">") ? (
            <blockquote
              key={part}
              className="border-l-2 border-zinc-600 pl-3 my-2 text-zinc-400 italic"
            >
              {part.slice(2)}
            </blockquote>
          ) : (
            <span key={part}>{part}</span>
          )
        )}
      </div>
    </div>
  );
}

// ── Main App ───────────────────────────────────────────────────────────

export default function AssistantApp() {
  const [activeTab, setActiveTab] = useState<
    "activity" | "skills" | "connections"
  >("activity");
  const [inputValue, setInputValue] = useState("");

  return (
    <div className="flex h-[calc(100vh-2.25rem)] bg-zinc-950 text-zinc-100">
      {/* ── Left: Chat Panel ────────────────────────────────────── */}
      <div className="w-[480px] flex flex-col border-r border-zinc-800">
        {/* Header */}
        <div className="px-5 py-4 border-b border-zinc-800 bg-gradient-to-r from-zinc-900 to-zinc-900/50">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-violet-600 to-blue-600 flex items-center justify-center text-white text-sm font-bold shadow-lg shadow-violet-600/20">
              T
            </div>
            <div>
              <h2 className="text-sm font-semibold text-zinc-100">
                Think Assistant
              </h2>
              <div className="flex items-center gap-1.5 mt-0.5">
                <span className="w-1.5 h-1.5 rounded-full bg-green-500" />
                <span className="text-[11px] text-zinc-500">
                  Online · 4 connections · 3 skills active
                </span>
              </div>
            </div>
          </div>
        </div>

        {/* Messages */}
        <div className="flex-1 overflow-y-auto">
          {MOCK_MESSAGES.map((msg) => (
            <ChatMessage key={msg.id} msg={msg} />
          ))}
        </div>

        {/* Quick Actions */}
        <div className="px-4 py-2 border-t border-zinc-800/50 flex gap-2 overflow-x-auto">
          {[
            "Check emails",
            "Summarize Slack",
            "Prep next meeting",
            "Weekly digest"
          ].map((action) => (
            <button
              key={action}
              type="button"
              className="px-3 py-1.5 text-[11px] font-medium text-zinc-400 bg-zinc-800/50 rounded-full border border-zinc-700/50 hover:bg-zinc-800 hover:text-zinc-300 transition-colors whitespace-nowrap shrink-0"
            >
              {action}
            </button>
          ))}
        </div>

        {/* Input */}
        <div className="p-3 border-t border-zinc-800 bg-zinc-900/50">
          <div className="flex gap-2">
            <input
              type="text"
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              placeholder="Ask anything, or tell me what to do..."
              className="flex-1 bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2.5 text-sm text-zinc-200 placeholder-zinc-500 focus:outline-none focus:border-violet-600 focus:ring-1 focus:ring-violet-600/50"
            />
            <button
              type="button"
              className="px-4 py-2.5 bg-gradient-to-r from-violet-600 to-blue-600 text-white text-sm font-medium rounded-lg hover:from-violet-500 hover:to-blue-500 transition-colors shadow-lg shadow-violet-600/20"
            >
              Send
            </button>
          </div>
        </div>
      </div>

      {/* ── Right: Dashboard Panel ──────────────────────────────── */}
      <div className="flex-1 flex flex-col bg-zinc-950">
        {/* Tab bar */}
        <div className="flex items-center gap-0 px-4 border-b border-zinc-800 bg-zinc-900/30">
          {(
            [
              { id: "activity", label: "Activity", icon: "⚡" },
              { id: "skills", label: "Skills", icon: "🧩" },
              { id: "connections", label: "Connections", icon: "🔗" }
            ] as const
          ).map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setActiveTab(tab.id)}
              className={`px-4 py-3 text-sm font-medium border-b-2 transition-colors ${
                activeTab === tab.id
                  ? "border-violet-500 text-zinc-100"
                  : "border-transparent text-zinc-500 hover:text-zinc-300"
              }`}
            >
              <span className="mr-1.5">{tab.icon}</span>
              {tab.label}
            </button>
          ))}

          {/* Spacer + stats */}
          <div className="flex-1" />
          <div className="flex items-center gap-4 text-[11px] text-zinc-600">
            <span>
              <span className="text-green-500 font-semibold">12</span> tasks
              today
            </span>
            <span>
              <span className="text-blue-500 font-semibold">3</span> pending
            </span>
            <span>
              <span className="text-amber-500 font-semibold">1</span> needs
              attention
            </span>
          </div>
        </div>

        {/* Tab content */}
        <div className="flex-1 overflow-y-auto p-4">
          {activeTab === "activity" && (
            <div className="space-y-2 max-w-2xl">
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-sm font-semibold text-zinc-300">
                  Recent Activity
                </h3>
                <button
                  type="button"
                  className="text-[11px] text-zinc-600 hover:text-zinc-400"
                >
                  Clear all
                </button>
              </div>
              {MOCK_ACTIVITY.map((a) => (
                <ActivityItem key={a.id} activity={a} />
              ))}
            </div>
          )}

          {activeTab === "skills" && (
            <div className="max-w-2xl">
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-sm font-semibold text-zinc-300">
                  Installed Skills
                </h3>
                <button
                  type="button"
                  className="text-[11px] text-violet-400 hover:text-violet-300 font-medium"
                >
                  + Install skill
                </button>
              </div>
              <div className="space-y-2">
                {MOCK_SKILLS.map((s) => (
                  <SkillCard key={s.id} skill={s} />
                ))}
              </div>

              <div className="mt-6 p-4 rounded-lg border border-dashed border-zinc-800 text-center">
                <div className="text-zinc-600 text-sm">
                  Skills are mini-programs your assistant runs automatically.
                </div>
                <div className="text-zinc-700 text-xs mt-1">
                  Write your own with natural language, or install from the
                  community.
                </div>
                <button
                  type="button"
                  className="mt-3 px-4 py-2 text-xs font-medium text-violet-400 bg-violet-600/10 rounded-lg hover:bg-violet-600/20 transition-colors"
                >
                  Create a custom skill
                </button>
              </div>
            </div>
          )}

          {activeTab === "connections" && (
            <div className="max-w-md">
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-sm font-semibold text-zinc-300">
                  Connected Services
                </h3>
              </div>
              <div className="space-y-1.5">
                {MOCK_CONNECTIONS.filter((c) => c.status === "connected").map(
                  (c) => (
                    <ConnectionCard key={c.id} connection={c} />
                  )
                )}
              </div>

              <div className="mt-6">
                <h4 className="text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-2">
                  Available
                </h4>
                <div className="space-y-1.5">
                  {MOCK_CONNECTIONS.filter((c) => c.status === "available").map(
                    (c) => (
                      <ConnectionCard key={c.id} connection={c} />
                    )
                  )}
                </div>
              </div>

              <div className="mt-6 p-4 rounded-lg bg-zinc-900/50 border border-zinc-800/50">
                <div className="text-sm font-medium text-zinc-300">
                  MCP Servers
                </div>
                <div className="text-[11px] text-zinc-500 mt-1">
                  Connect to any MCP-compatible server for custom integrations.
                </div>
                <div className="flex gap-2 mt-3">
                  <input
                    type="text"
                    placeholder="https://mcp.example.com/sse"
                    className="flex-1 bg-zinc-800 border border-zinc-700 rounded px-2.5 py-1.5 text-xs text-zinc-300 placeholder-zinc-600 focus:outline-none focus:border-violet-600"
                  />
                  <button
                    type="button"
                    className="px-3 py-1.5 text-xs font-medium bg-zinc-800 text-zinc-400 rounded hover:bg-zinc-700 transition-colors"
                  >
                    Connect
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Bottom status bar */}
        <div className="px-4 py-2 border-t border-zinc-800 bg-zinc-900/30 flex items-center justify-between">
          <div className="flex items-center gap-3 text-[10px] text-zinc-600">
            <span className="flex items-center gap-1">
              <span className="w-1.5 h-1.5 rounded-full bg-green-500" />
              All systems operational
            </span>
            <span>·</span>
            <span>Next scheduled: Email Triage in 12 min</span>
          </div>
          <div className="flex items-center gap-2 text-[10px] text-zinc-600">
            <span>Powered by Think Agent</span>
            <span className="text-zinc-800">|</span>
            <span>Cloudflare Durable Objects</span>
          </div>
        </div>
      </div>
    </div>
  );
}
