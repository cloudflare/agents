# UI

Plain React and [Kumo](https://github.com/cloudflare/kumo) components. Nothing
here is specific to Channels — it reads the JSON API in
[`src/api.ts`](../api.ts) and polls `/api/directory` for new activity.

Skip this directory. The Channels code lives in:

| File                                                        | What it shows                                              |
| ----------------------------------------------------------- | ---------------------------------------------------------- |
| [`src/server.ts`](../server.ts)                             | Every Channel, its routing, the Host, and the entry points |
| [`src/conversation.ts`](../conversation.ts)                 | Storing what arrived, and answering it                     |
| [`src/directory.ts`](../directory.ts)                       | Linking channel identities to users                        |
| [`src/support-form-channel.ts`](../support-form-channel.ts) | Writing a Channel of your own                              |
