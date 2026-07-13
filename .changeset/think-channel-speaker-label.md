---
"@cloudflare/think": minor
---

feat(think): add channelSpeakerLabel option to MessengerDefinition for configurable channel speaker prefixing

Channel (non-DM) messages and action events are prefixed with the speaker label
so the model can attribute multi-user traffic; direct messages never get a
prefix. Previously action events were labelled even in DMs — they now follow the
same channel-only rule as regular messages.
