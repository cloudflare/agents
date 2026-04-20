import { createWorkersAI } from "workers-ai-provider";
import { routeAgentRequest } from "agents";
import { AIChatAgent } from "@cloudflare/ai-chat";
import { streamText, convertToModelMessages } from "ai";
import type { OnChatMessageOptions } from "@cloudflare/ai-chat";
import { tools } from "./tools";

export class StructuredInputAgent extends AIChatAgent {
  async onChatMessage(_onFinish: unknown, options?: OnChatMessageOptions) {
    const workersai = createWorkersAI({ binding: this.env.AI });

    const result = streamText({
      abortSignal: options?.abortSignal,
      model: workersai("@cf/moonshotai/kimi-k2.6", {
        sessionAffinity: this.sessionAffinity
      }),
      system: `You are a helpful assistant that gathers information from users through structured inputs.

You have access to tools that present interactive UI elements to the user:
- askMultipleChoice: present options for the user to pick from
- askYesNo: ask a yes/no question
- askFreeText: ask for open-ended text input
- askRating: ask the user to rate something on a scale

Use these tools naturally in conversation. When you need information from the user,
choose the most appropriate input type. For example:
- Use askMultipleChoice when there are clear options to choose from
- Use askYesNo for binary decisions
- Use askFreeText when you need names, descriptions, or detailed feedback
- Use askRating for subjective assessments

After receiving the user's response, acknowledge it and continue the conversation.
You can chain multiple questions together to build up context.

Some example scenarios you're great at:
- Helping someone plan a trip (destination, dates, preferences, budget)
- Running a quick survey or questionnaire
- Onboarding a user to a new product
- Helping someone make a decision by narrowing down options
- Gathering project requirements`,
      messages: await convertToModelMessages(this.messages),
      tools
    });

    return result.toUIMessageStreamResponse();
  }
}

export default {
  async fetch(request: Request, env: Env) {
    return (
      (await routeAgentRequest(request, env)) ||
      new Response("Not found", { status: 404 })
    );
  }
} satisfies ExportedHandler<Env>;
