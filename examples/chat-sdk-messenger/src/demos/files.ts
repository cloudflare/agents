import type { Demo } from "./types";

export const FILE_DEMOS: Demo[] = [
  {
    id: "file-text",
    label: "Text file upload",
    async run(thread) {
      const data = new Blob(
        [
          [
            "Chat SDK on Cloudflare Workers",
            "",
            "This file was generated inside a Worker and uploaded through the Telegram adapter."
          ].join("\n")
        ],
        { type: "text/plain" }
      );

      await thread.post({
        markdown: "Here is a small generated text file.",
        files: [
          {
            data,
            filename: "chat-sdk-worker.txt"
          }
        ]
      });
    }
  }
];
