import type { Demo } from "./types";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function* streamMarkdown(): AsyncIterable<string> {
  const chunks = [
    "Streaming ",
    "**MarkdownV2** ",
    "through Chat SDK ",
    "uses Telegram post+edit updates."
  ];

  for (const chunk of chunks) {
    yield chunk;
    await delay(250);
  }
}

export const MARKDOWN_DEMOS: Demo[] = [
  {
    id: "md-basic",
    label: "Markdown basics",
    async run(thread) {
      await thread.post({
        markdown:
          "**Bold**, _italic_, `inline code`, and [a link](https://chat-sdk.dev/)."
      });
    }
  },
  {
    id: "md-code",
    label: "Code block",
    async run(thread) {
      await thread.post({
        markdown:
          "```ts\nconst bot = new Chat({ adapters: { telegram }, state });\n```"
      });
    }
  },
  {
    id: "md-stream",
    label: "Streaming edit",
    async run(thread) {
      await thread.post(streamMarkdown());
    }
  }
];
