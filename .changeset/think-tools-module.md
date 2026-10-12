---
"@cloudflare/think": minor
---

`createExecuteTool` and `createExecuteRuntime` are deprecated. Code execution moves to the Workspace: give it a JavaScript backend with a `ws:tools` module, `createToolBindings(forAISDKTools(() => this.getTools()))` from `@cloudflare/computer`. Code the model runs with `exec` then imports the agent's tools (`import { getWeather } from "ws:tools"`) and reads files through `node:fs`. The codemode-based execute tool keeps working until it is removed with `@cloudflare/codemode`.
