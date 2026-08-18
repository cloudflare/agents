# `@cloudflare/channels`

`@cloudflare/channels` gives an agent one interface for sending and receiving
messages across different platforms. Use a Channel directly, expose it as an AI
tool, or register it with a durable `ChannelHost` that owns routing and delivery
recovery.

> [!NOTE]
> Channels is experimental. Its interface _will_ change before the package reaches
> a stable release.

## Install

```bash
npm install @cloudflare/channels
```

## Create channels

Each adapter turns provider configuration into the same `Channel` interface.
The rest of your application does not need to know which transport it uses.

```typescript
import { email, fallback, fanout, telegram } from "@cloudflare/channels";

const supportChat = telegram({
  botToken: env.TELEGRAM_BOT_TOKEN,
  chatId: env.TELEGRAM_SUPPORT_CHAT_ID,
  webhook: {
    secretToken: env.TELEGRAM_WEBHOOK_SECRET
  }
});

const supportEmail = email({
  binding: env.EMAIL,
  from: "agent@example.com",
  to: "support@example.com"
});

const resilientSupport = fallback([supportChat, supportEmail]);
const everySupportRoute = fanout([supportChat, supportEmail]);
```

`fallback()` tries routes in order, advancing after a confirmed failure.
`fanout()` sends to every route. A partial or uncertain fanout is reported as
`uncertain`, because retrying the whole composition could duplicate a delivery.

### Deliver synthesized speech to a browser

The Voice adapter lives with the other Channel adapters and builds on
`@cloudflare/voice` without making the Voice package depend on Channels:

```typescript
import { browserVoice } from "@cloudflare/channels/voice";
import { WorkersAITTS } from "@cloudflare/voice";

const spokenUpdates = browserVoice({
  tts: new WorkersAITTS(env.AI),
  getConnection: () => [...agent.getConnections("browser-voice")][0]
});
```

Connect the tagged browser surface with `VoiceClient` or `useVoiceAgent()`. The
adapter uses the Voice client protocol for playback and does not require
`withVoice()`, a microphone, or a speech-to-text provider. The default audio
format is MP3; configure `audioFormat` and `sampleRate` for raw PCM providers.

## 1. Deliver directly

All Channels use the same interface:

```typescript
await supportChat.deliver({
  title: "Import needs attention",
  markdown: "The customer import stopped after **1,240 records**."
});

await resilientSupport.deliver({
  title: "Import needs attention",
  markdown: "The customer import stopped after **1,240 records**."
});

await everySupportRoute.deliver({
  title: "Import needs attention",
  markdown: "The customer import stopped after **1,240 records**."
});
```

<!-- TODO: add screenshots of rendered messages on various platforms -->

## 2. Give a Channel to a model

Channels expose tool adapters for the AI SDK and TanStack AI:

### AI SDK

```typescript
import { generateText, stepCountIs } from "ai";
import { createWorkersAI } from "workers-ai-provider";
import { createChannelTool } from "@cloudflare/channels/ai-sdk";

const workersai = createWorkersAI({ binding: env.AI });

const result = await generateText({
  model: workersai("@cf/moonshotai/kimi-k2.7-code"),
  prompt:
    "An import stopped after 1,240 records. Notify support and summarize what you did.",
  tools: {
    contactSupport: createChannelTool(resilientSupport, {
      description: "Contact support when a person needs to intervene"
    })
  },
  stopWhen: stepCountIs(2)
});
```

### TanStack AI

```typescript
import { chat } from "@tanstack/ai";
import { createWorkersAiChat } from "@cloudflare/tanstack-ai";
import { createChannelTool } from "@cloudflare/channels/tanstack-ai";

const stream = chat({
  adapter: createWorkersAiChat("@cf/meta/llama-4-scout-17b-16e-instruct", {
    binding: env.AI
  }),
  messages: [
    {
      role: "user",
      content: "The import failed. Notify support and tell me what you did."
    }
  ],
  tools: [
    createChannelTool(resilientSupport, {
      name: "contact_support",
      description: "Contact support when a person needs to intervene"
    })
  ]
});
```

## 3. Use a durable Host

`ChannelHost` is the durable boundary around a set of Channels. It remembers
where messages should go, records delivery attempts before contacting a provider, and
recovers confirmed failures after an isolate restarts. It also connects replies
to the interaction that caused them.

```typescript
import { ChannelHost } from "@cloudflare/channels";

const host = new ChannelHost({
  storage: ctx.storage,
  channels: {
    supportChat,
    supportEmail,
    resilientSupport
  },

  async onMessage({ channelId, message }) {
    // Recovery can replay this message, so make the handler idempotent
    await myApp.runTurn(channelId, message);
  },

  async onApprovalResponse({ interactionId, decision }) {
    await myApp.approveInteraction(interactionId, decision);
  }
});

await host.init();

async function alarm() {
  await host.handleAlarm();
}
```

### Handle HTTP and Email ingress

One HTTP entry point covers every registered Channel webhook:

```typescript
export class SupportChannels extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    const response = await this.host.handleRequest(request);
    if (response) return response;
    // your handlers can go here
    return new Response("Not found", { status: 404 });
  }

  async handleEmail(input: {
    from: string;
    to: string;
    headers: [string, string][];
    raw: ArrayBuffer;
  }): Promise<boolean> {
    return this.host.handleEmail({
      from: input.from,
      to: input.to,
      headers: new Headers(input.headers),
      getRaw: async () => new Uint8Array(input.raw)
    });
  }
}
```

The top-level Worker forwards HTTP requests and Workers Email events to the
same Durable Object instance:

```typescript
export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return env.SUPPORT_CHANNELS.getByName("default").fetch(request);
  },

  async email(message: ForwardableEmailMessage, env: Env): Promise<void> {
    const raw = await new Response(message.raw).arrayBuffer();
    await env.SUPPORT_CHANNELS.getByName("default").handleEmail({
      from: message.from,
      to: message.to,
      headers: [...message.headers],
      raw
    });
  }
} satisfies ExportedHandler<Env>;
```

### Request approval

The Host exposes a utility for durably correlating inbound approvals to outbound requests:

```typescript
await host.requestApproval({
  interactionId: "deploy-42",
  request: {
    title: "Production deployment",
    summary: "Deploy version 2026.08.17 to production?",
    input: {
      version: "2026.08.17",
      environment: "production"
    }
  }
});
```

Users can respond to approval requests through native surfaces (e.g. Telegram
buttons) or HTTP inbound URLs, resolved by the Channel Host itself.

### Deliver durably

Messages can be delivered through the Host to avoid manual channel selection
(for example, after applying a user's saved preference). A stable delivery ID
makes repeated Host calls idempotent: a terminal result is returned rather than
sent again. Confirmed retryable failures may produce another provider attempt;
an uncertain outcome is never retried automatically.

```typescript
await host.deliver({
  deliveryId: "import-alert-2026-08-17",
  message: {
    title: "Import needs attention",
    markdown: "The customer import stopped after **1,240 records**."
  }
});
```

On recovery, a confirmed retryable failure is scheduled with the same stable delivery ID.
The Host exposes the Channel delivery surface directly, so the same durable
route can be used as an agent tool:

```typescript
const durableSupportTool = createChannelTool(host);
```

### Share a Durable Object alarm

Durable Objects only support a single alarm at once. When your application also
uses alarms, you can multiplex it with `sharedAlarm`:

```typescript
import { ChannelHost, sharedAlarm } from "@cloudflare/channels";

const alarms = sharedAlarm(ctx.storage);
const applicationAlarms = alarms.source("application");
const host = new ChannelHost({
  storage: ctx.storage,
  scheduler: alarms.source("channels"),
  channels,
  onMessage,
  onApprovalResponse
});

await host.init();

await applicationAlarms.schedule(
  "some-alarm-id",
  Date.now() + 24 * 60 * 60 * 1000
);

async function alarm() {
  await alarms.handleAlarm({
    channels: () => host.handleAlarm(),
    application: (alarmIds) => {
      /* your alarm logic here */
    }
  });
}
```

### Use with Think

Channels can be used as a tool and action approval provider with a Think agent:

```typescript
import { email, fallback, telegram } from "@cloudflare/channels";
import { Think } from "@cloudflare/think";

export class SupportAgent extends Think<Env> {
  override configureChannelHost() {
    const teamChat = telegram({
      botToken: this.env.TELEGRAM_BOT_TOKEN,
      chatId: this.env.TELEGRAM_SUPPORT_CHAT_ID,
      webhook: {
        secretToken: this.env.TELEGRAM_WEBHOOK_SECRET
      }
    });
    const supportEmail = email({
      binding: this.env.EMAIL,
      from: "agent@example.com",
      to: "support@example.com"
    });

    return {
      channels: {
        teamChat,
        supportEmail
      },
      publicBaseUrl: this.env.PUBLIC_AGENT_URL
    };
  }
}
```

## Custom channels

A custom Channel implements one provider attempt. This webhook example supports
ordinary delivery and Host approval links while distinguishing confirmed
failure from an unknown network outcome:

```typescript
import type {
  Channel,
  ChannelMessage,
  DeliveryResult
} from "@cloudflare/channels";

async function sendWebhook(message: ChannelMessage): Promise<DeliveryResult> {
  let response: Response;

  try {
    response = await fetch(env.OPERATIONS_WEBHOOK_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(message)
    });
  } catch {
    return {
      status: "uncertain",
      error: {
        code: "network_error",
        message: "The webhook may have received the message"
      }
    };
  }

  if (!response.ok) {
    return {
      status: "failed",
      retryable: response.status === 429 || response.status >= 500,
      error: {
        code: "webhook_rejected",
        message: `The webhook returned HTTP ${response.status}`
      }
    };
  }

  return {
    status: "delivered",
    reference: response.headers.get("x-message-id") ?? undefined
  };
}

const operationsWebhook: Channel = {
  // send ordinary messages through this Channel
  deliver: sendWebhook,

  // send approval requests through this Channel
  async requestApproval({ request, getApprovalLinks }) {
    const links = await getApprovalLinks();
    return sendWebhook({
      title: request.title,
      markdown: [
        request.summary,
        `Approve: ${links.approve}`,
        `Reject: ${links.reject}`
      ].join("\n\n")
    });
  }
};
```

Register and use it like a built-in adapter:

```typescript
const host = new ChannelHost({
  storage: ctx.storage,
  channels: { operationsWebhook },
  publicBaseUrl: env.PUBLIC_AGENT_URL,
  scheduler: channelAlarms,
  onApprovalResponse: resolveApprovalInApplicationLedger
});
```

## Future Work

- [ ] Streaming output delivery
- [ ] Native agent output to Channel
- [ ] ? Automatic Webhook registration
- [ ] Clarify Identity -- one Channel/ChannelHost per what?
- [ ] More built-in channels
- [ ] Stress testing
- [ ] Security review of approval flows
- [ ] Multiplayer Channels
- [ ] Rendering templates (pretty emails)
- [ ] Tool description overrides
