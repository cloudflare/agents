import { AIChatAgent } from "@cloudflare/ai-chat";

export class ChatAgent extends AIChatAgent<Env> {
  async onChatMessage() {
    // Simple echo response for the playground
    // In a real app, you'd use AI SDK's streamText here
    if (!this.messages || this.messages.length === 0) {
      return new Response(JSON.stringify({ message: "No message" }), {
        headers: { "Content-Type": "application/json" }
      });
    }

    const lastMessage = this.messages[this.messages.length - 1];

    // Get text from message parts
    let text = "No message";
    if (lastMessage?.parts && Array.isArray(lastMessage.parts)) {
      const textPart = lastMessage.parts.find((p) => p.type === "text");
      if (textPart && "text" in textPart) {
        text = textPart.text;
      }
    }

    return new Response(
      JSON.stringify({
        message: `You said: ${text}`
      }),
      {
        headers: { "Content-Type": "application/json" }
      }
    );
  }
}
