import { useState } from "react";
import { Button, Surface, Text } from "@cloudflare/kumo";
import { DemoWrapper } from "../../layout";
import { CodeExplanation, LogPanel, type CodeSection } from "../../components";
import { useLogs } from "../../hooks";

type StoryId = "email" | "webhook" | "push" | "a2a" | "x402" | "browser";

const stories: Array<{
  id: StoryId;
  title: string;
  product: string;
  description: string;
  events: Array<[string, unknown]>;
  examplePath: string;
}> = [
  {
    id: "email",
    title: "Email Concierge",
    product: "Receive, reason, send, and route replies",
    description:
      "An agent receives an email, classifies it, drafts a response, sends through Email Service, and signs routing headers so replies return to the same agent.",
    events: [
      [
        "email_received",
        { from: "customer@example.com", subject: "Need help" }
      ],
      ["agent_classified", { intent: "support", priority: "normal" }],
      ["draft_created", { tone: "helpful", needsReview: true }],
      ["email_sent", { signedReplyHeaders: true }]
    ],
    examplePath: "examples/email-agent"
  },
  {
    id: "webhook",
    title: "Webhook Triage",
    product: "Per-resource agents for inbound product events",
    description:
      "A GitHub webhook routes to an agent named for the repository. The agent stores events, summarizes them, and broadcasts live dashboard updates.",
    events: [
      ["webhook_verified", { provider: "github", event: "issues.opened" }],
      ["agent_selected", { name: "cloudflare/agents" }],
      ["issue_summarized", { priority: "high", labels: ["bug"] }],
      ["dashboard_broadcast", { connectedClients: 2 }]
    ],
    examplePath: "examples/github-webhook"
  },
  {
    id: "push",
    title: "Push Reminder Agent",
    product: "Schedules that notify users later",
    description:
      "The browser registers a push subscription. The agent stores it, schedules durable work, and sends a notification when the task fires.",
    events: [
      ["subscription_saved", { endpoint: "browser-push-endpoint" }],
      ["reminder_scheduled", { delay: "10 minutes" }],
      ["schedule_fired", { callback: "sendReminder" }],
      ["push_sent", { title: "Time to check in" }]
    ],
    examplePath: "examples/push-notifications"
  },
  {
    id: "a2a",
    title: "A2A Task Exchange",
    product: "Agents as interoperable protocol participants",
    description:
      "One agent publishes an A2A card, receives a task, streams progress, and returns an artifact over the protocol.",
    events: [
      ["agent_card_loaded", { capabilities: ["tasks", "streaming"] }],
      ["task_created", { kind: "research" }],
      ["progress_streamed", { percent: 60 }],
      ["artifact_returned", { type: "summary" }]
    ],
    examplePath: "examples/a2a"
  },
  {
    id: "x402",
    title: "Paid Tool Call",
    product: "Payments before expensive actions",
    description:
      "A paid endpoint or MCP tool returns payment requirements. The client confirms, pays with x402, and retries the protected call.",
    events: [
      ["payment_required", { price: "0.01 USDC" }],
      ["user_confirmed", { maxPaymentValue: "0.10 USDC" }],
      ["payment_attached", { network: "base-sepolia" }],
      ["tool_completed", { result: "premium result" }]
    ],
    examplePath: "examples/x402"
  },
  {
    id: "browser",
    title: "Browser Worker",
    product: "Agents controlling browser sessions",
    description:
      "Browser tools let an agent open pages, inspect snapshots, click controls, and turn web automation into an AI tool surface.",
    events: [
      ["browser_connected", { session: "cdp" }],
      ["snapshot_read", { buttons: 4, links: 12 }],
      ["action_clicked", { target: "Run report" }],
      ["result_extracted", { status: "complete" }]
    ],
    examplePath: "agents/browser"
  }
];

const codeSections: CodeSection[] = [
  {
    title: "Route external events into the right agent",
    description:
      "Most product integrations start with a Worker request or email event, validate it, derive a stable agent name, and forward to that Durable Object.",
    code: `export default {
  async fetch(request: Request, env: Env) {
    const event = await verifyGitHubWebhook(request, env.GITHUB_SECRET);
    const agent = await getAgentByName(env.RepoAgent, event.repository.full_name);
    return agent.fetch(request);
  },

  async email(message: ForwardableEmailMessage, env: Env) {
    await routeAgentEmail(message, env, { resolver });
  },
};`
  },
  {
    title: "Use bindings for real product delivery",
    description:
      "Agents are most useful when they hold state and call platform bindings: Email Service, Browser Rendering, Workers AI, Workflows, Durable Objects, Queues, or Push APIs.",
    code: `class ConciergeAgent extends Agent<Env> {
  async onEmail(email: AgentEmail) {
    const draft = await this.classifyAndDraft(email);

    await this.sendEmail({
      binding: this.env.EMAIL,
      to: email.from,
      from: "support@example.com",
      subject: "Re: " + email.headers.get("subject"),
      text: draft,
      secret: this.env.EMAIL_SECRET,
    });
  }
}`
  },
  {
    title: "Keep heavyweight setup in focused examples",
    description:
      "The Playground should explain the product shape and link out when a demo needs real webhooks, browser permissions, wallet setup, OAuth apps, or deployed email routing.",
    code: `// Playground page
// - Simulates the event flow
// - Shows the agent, binding, and routing code
// - Links to the standalone example for provider setup`
  }
];

export function ProductIntegrationsDemo() {
  const [selectedId, setSelectedId] = useState<StoryId>("email");
  const { logs, addLog, clearLogs } = useLogs();
  const selected =
    stories.find((story) => story.id === selectedId) ?? stories[0];

  const runStory = () => {
    clearLogs();
    selected.events.forEach(([type, payload], index) => {
      window.setTimeout(() => addLog("in", type, payload), index * 250);
    });
  };

  return (
    <DemoWrapper
      title="Product Integrations"
      description={
        <>
          Agents become most compelling when they sit behind real product
          surfaces: inboxes, webhooks, push notifications, paid tools, browser
          automation, and interoperable protocols. This page shows the product
          shape for integrations that need extra provider setup outside a local
          Playground session.
        </>
      }
    >
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="space-y-6">
          <Surface className="p-4 rounded-lg ring ring-kumo-line">
            <div className="mb-4">
              <Text variant="heading3" as="h3">
                Integration Stories
              </Text>
            </div>
            <div className="grid grid-cols-1 gap-2">
              {stories.map((story) => (
                <button
                  key={story.id}
                  type="button"
                  onClick={() => setSelectedId(story.id)}
                  className={`text-left p-3 rounded border transition-colors ${
                    selectedId === story.id
                      ? "border-kumo-brand bg-kumo-elevated"
                      : "border-kumo-line hover:border-kumo-interact"
                  }`}
                >
                  <Text bold size="sm">
                    {story.title}
                  </Text>
                  <p className="mt-1 text-xs text-kumo-subtle">
                    {story.product}
                  </p>
                </button>
              ))}
            </div>
          </Surface>
        </div>

        <div className="space-y-6">
          <Surface className="p-4 rounded-lg ring ring-kumo-line">
            <div className="mb-3">
              <Text variant="heading3" as="h3">
                {selected.title}
              </Text>
            </div>
            <p className="text-sm text-kumo-subtle mb-4">
              {selected.description}
            </p>
            <div className="p-3 rounded bg-kumo-elevated mb-4">
              <Text bold size="sm">
                Full setup
              </Text>
              <div className="mt-1">
                <code className="text-xs text-kumo-subtle">
                  {selected.examplePath}
                </code>
              </div>
            </div>
            <Button variant="primary" onClick={runStory} className="w-full">
              Simulate Event Flow
            </Button>
          </Surface>

          <LogPanel logs={logs} onClear={clearLogs} maxHeight="260px" />
        </div>
      </div>

      <Surface className="mt-6 p-4 rounded-lg ring ring-kumo-line">
        <div className="mb-4">
          <Text variant="heading3" as="h3">
            What These Have in Common
          </Text>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          {[
            [
              "Route",
              "Validate the incoming event and pick a stable agent name."
            ],
            [
              "Remember",
              "Store event history, user preferences, tokens, and pending work in the agent."
            ],
            [
              "Act",
              "Call bindings, tools, workflows, or other agents and broadcast results."
            ]
          ].map(([title, description]) => (
            <div key={title} className="p-3 rounded bg-kumo-elevated">
              <Text bold size="sm">
                {title}
              </Text>
              <p className="mt-1 text-xs text-kumo-subtle">{description}</p>
            </div>
          ))}
        </div>
      </Surface>

      <CodeExplanation sections={codeSections} />
    </DemoWrapper>
  );
}
