import {
  Card,
  CardText,
  Section,
  Fields,
  Field,
  Actions,
  Button,
  LinkButton,
  CardLink,
  Divider
} from "chat";
import type { Mode } from "./types";

// Chat SDK cards use function-call syntax (not JSX) because the
// @cloudflare/workers-types JSX runtime conflicts with Chat SDK's.
// CardText() is the runtime function; Text is type-only.

export function ResponseCard({ currentMode }: { currentMode: Mode }) {
  return Card({
    title: "Was this helpful?",
    children: [
      Actions([
        Button({ id: "helpful", label: "👍 Helpful", style: "primary" }),
        Button({ id: "not_helpful", label: "👎 Not helpful", style: "danger" })
      ]),
      Actions([Button({ id: "summarize", label: "📝 Summarize Thread" })]),
      Divider(),
      Section([CardText(`⚙️ Response mode: **${currentMode}**`)]),
      Actions([
        Button({ id: "mode_concise", label: "Concise" }),
        Button({ id: "mode_detailed", label: "Detailed" }),
        Button({ id: "mode_creative", label: "Creative" })
      ])
    ]
  });
}

export function HelpCard() {
  return Card({
    title: "Sidekick",
    subtitle: "Your AI assistant in Discord",
    children: [
      Section([
        CardText("👋 **Getting Started**"),
        CardText(
          "Use `/ask` to start a conversation. I'll remember context for follow-ups in the same channel."
        )
      ]),
      Divider(),
      Section([
        CardText("🚀 **What I Can Do**"),
        CardText(
          [
            "🔥 Stream AI responses in real-time",
            "⚙️ Switch modes: concise, detailed, or creative",
            "📝 Summarize threads on demand",
            "🙌 React to your emoji"
          ].join("\n")
        )
      ]),
      Divider(),
      Section([
        CardText("⭐ **Learn More**"),
        CardLink({
          url: "https://chat-sdk.dev/docs",
          label: "Chat SDK Documentation"
        }),
        CardLink({
          url: "https://developers.cloudflare.com/agents/",
          label: "Cloudflare Agents SDK"
        })
      ]),
      Divider(),
      Actions([
        LinkButton({
          url: "https://chat-sdk.dev/docs",
          label: "🚀 Chat SDK Docs"
        })
      ])
    ]
  });
}

export function SummaryCard({
  messageCount,
  participantCount,
  summary
}: {
  messageCount: number;
  participantCount: number;
  summary: string;
}) {
  return Card({
    title: "📝 Thread Summary",
    children: [
      Fields([
        Field({ label: "Messages", value: String(messageCount) }),
        Field({ label: "Participants", value: String(participantCount) })
      ]),
      Divider(),
      CardText(summary)
    ]
  });
}
