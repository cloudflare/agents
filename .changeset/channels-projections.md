---
"agents": minor
---

Add projections, which map a harness vendor's message format to and from Channels transcript messages and response chunks, one entry point per vendor. `agents/experimental/channels/projections/ai-sdk` holds the AI SDK conversions (`toResponseChunks`, `toTranscriptMessage`, `toUIMessageChunk`, `toUIMessage`). `agents/experimental/channels/projections/pi` projects pi-durable entries and live events. `agents/harness/pi` gains `piChannelsHarness`, which puts `PiHarness` behind the shared harness interface so `Channels.forHarness` can serve it.
