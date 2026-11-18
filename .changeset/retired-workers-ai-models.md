---
"agents": patch
"@cloudflare/think": patch
---

Move off the Workers AI models retired on November 20, 2026: drop MeloTTS and `whisper-tiny-en` handling, send `@cf/google/embeddinggemma-2` its `{ input }` shape, and suggest `@cf/deepseek-ai/deepseek-v4.1-flash-1017` in examples and messages. See [Planned model deprecations](https://developers.cloudflare.com/changelog/post/2026-11-05-planned-model-deprecations/).
