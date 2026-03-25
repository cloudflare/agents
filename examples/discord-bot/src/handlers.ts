import type { Chat, Adapter } from "chat";
import { getAgentByName } from "agents";
import { ResponseCard, HelpCard, SummaryCard } from "./cards";
import type { ThreadState, Mode } from "./types";
import { DEFAULT_MODE } from "./types";

function getAgentStub(env: Env, threadId: string) {
  return getAgentByName(env.CHAT_AGENT, threadId);
}

export function registerHandlers(
  bot: Chat<Record<string, Adapter<unknown, unknown>>, ThreadState>,
  env: Env
): void {
  // --- /ask: Generate an AI response via the Agent DO ---
  bot.onSlashCommand("/ask", async (event) => {
    if (!event.text) {
      await event.channel.post("Usage: `/ask <your question>`");
      return;
    }

    const raw = event.raw as Record<string, unknown>;
    const channelId =
      typeof raw?.channel_id === "string"
        ? raw.channel_id
        : (event.channel?.id ?? "unknown");
    const state = (await event.channel.state) as ThreadState | null;
    const currentMode: Mode = state?.mode ?? DEFAULT_MODE;

    const stub = await getAgentStub(env, channelId);
    const responseText = await stub.ask(
      event.text,
      channelId,
      event.user.userId,
      event.user.fullName,
      currentMode
    );

    await event.channel.post(
      responseText || "Sorry, I couldn't generate a response."
    );
    await event.channel.post(ResponseCard({ currentMode }));
  });

  // --- @mention: Same as /ask but triggered via Gateway WebSocket ---
  bot.onNewMention(async (thread, message) => {
    if (!message.text) return;
    await thread.startTyping();

    const state = (await thread.state) as ThreadState | null;
    const currentMode: Mode = state?.mode ?? DEFAULT_MODE;

    const stub = await getAgentStub(env, thread.id);
    const responseText = await stub.ask(
      message.text,
      thread.id,
      message.author.userId,
      message.author.fullName ?? message.author.userName,
      currentMode
    );

    await thread.post(responseText || "Sorry, I couldn't generate a response.");
    await thread.post(ResponseCard({ currentMode }));
  });

  // --- /help: Show capabilities card ---
  bot.onSlashCommand("/help", async (event) => {
    await event.channel.post(HelpCard());
  });

  // --- Feedback buttons: Ephemeral acknowledgement ---
  bot.onAction(["helpful", "not_helpful"], async (event) => {
    if (!event.thread) return;
    const text =
      event.actionId === "helpful"
        ? "❤️ Thanks for the feedback!"
        : "🤔 I'll try to do better next time.";
    await event.thread.postEphemeral(event.user, text, { fallbackToDM: true });
  });

  // --- Mode buttons: Update per-thread response style ---
  bot.onAction(
    ["mode_concise", "mode_detailed", "mode_creative"],
    async (event) => {
      if (!event.thread) return;
      const newMode = event.actionId.replace("mode_", "") as Mode;
      await event.thread.setState({ mode: newMode });
      await event.thread.postEphemeral(
        event.user,
        `⚙️ Mode set to **${newMode}**`,
        { fallbackToDM: true }
      );
    }
  );

  // --- Summarize button: Condense thread history via the Agent DO ---
  bot.onAction("summarize", async (event) => {
    if (!event.thread) return;
    const stub = await getAgentStub(env, event.thread.id);
    const result = await stub.summarize(event.thread.id);

    await event.thread.post(
      SummaryCard({
        messageCount: result.messageCount,
        participantCount: result.participantCount,
        summary: result.text
      })
    );
  });
}
