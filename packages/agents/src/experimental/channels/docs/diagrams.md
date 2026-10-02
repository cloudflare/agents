# Channels diagrams

Terms are defined in [CONTEXT.md](./CONTEXT.md).

## Layers

The agent owns turns and the transcript. Channels carries inbound events in and responses, turn statuses and snapshots out.

```mermaid
flowchart LR
  I["<b>Interfaces</b><br/>browser, TUI, Slack, Telegram"]
  C["<b>Channels</b><br/>surfaces, responses"]
  A["<b>Agent</b><br/>turns, transcript"]
  I -- inbound events --> C
  C -- inbound events --> A
  A -- "responses, turn statuses,<br/>conversation snapshots" --> C
  C -- "responses, turn statuses,<br/>conversation snapshots" --> I
```

## Turn status

Queued, running or settled. Only a turn awaiting input can run again. Its continuation queues if another turn is running.

```mermaid
flowchart LR
  Queued -- agent starts it --> Running
  Queued -- cancel --> Aborted
  Running --> Completed
  Running --> Failed
  Running -- cancel --> Aborted
  Running --> AwaitingInput["Awaiting input"]
  AwaitingInput -- "tool result or<br/>approval response" --> Running
  AwaitingInput -- "tool result or approval response<br/>while another turn runs" --> Queued
  AwaitingInput -- cancel --> Aborted

  subgraph Settled
    Completed
    Failed
    Aborted
    AwaitingInput
  end
```

## Connecting mid-turn

The surface listens for turn statuses before it reads the snapshot, so nothing published in between is lost.

```mermaid
sequenceDiagram
  participant B as Browser
  participant C as Web Channel
  participant A as Agent harness
  B->>C: connect
  C->>A: read conversation snapshot
  A-->>C: transcript + turn-1 running on response-1
  C-->>B: snapshot
  B->>C: subscribe response-1 from cursor
  C-->>B: replay, then live output
  A->>C: turn-1 settled, completed, messages [assistant-msg-1]
  C-->>B: turn-1 settled
  Note over B: swap live output for saved assistant-msg-1
```

## Client tool and continuation

A continuation extends the saved message named by `extends`.

```mermaid
sequenceDiagram
  participant B as Browser
  participant C as Web Channel
  participant A as Agent
  B->>C: message event-1 "What's the weather where I am?"
  C->>A: message event-1
  A->>C: turn-1 running on response-1
  A->>C: response-1: text + tool call call-1 (getLocation)
  Note over A: saves assistant-msg-1 with call-1 pending
  A->>C: response-1 ends
  A->>C: message assistant-msg-1, operation event-1 done
  Note over C: a tool call waits: turn event-1 awaiting input
  B->>C: tool result for call-1
  C->>A: tool result for call-1
  A->>C: turn-1 running on response-2, extends assistant-msg-1
  A->>C: response-2: text "18°C and sunny in Lisbon"
  Note over B: appends response-2 to assistant-msg-1
  Note over A: saves final assistant-msg-1
  A->>C: response-2 ends
  A->>C: turn-1 settled, completed, messages [assistant-msg-1]
```

## Stop, then reload

Partial output is saved by the agent, so a reload finds nothing left to resume.

```mermaid
sequenceDiagram
  participant B as Browser
  participant C as Web Channel
  participant A as Agent
  A->>C: turn-1 running on response-1
  B->>C: cancel turn-1
  C->>A: cancel turn-1
  Note over A: stops producing, saves partial assistant-msg-1
  A->>C: response-1 ends
  A->>C: turn-1 settled, aborted, messages [assistant-msg-1]
  B->>C: reload and connect
  C->>A: read conversation snapshot
  A-->>C: transcript with assistant-msg-1, no open turns
  C-->>B: snapshot
```

## Recovery after eviction

Channels only reports the interrupted response. The agent decides to start a new attempt.

```mermaid
sequenceDiagram
  participant B as Browser
  participant C as Web Channel
  participant A as Agent
  A->>C: turn-1 running on response-2, extends assistant-msg-1
  Note over A,C: object evicted
  Note over C: on wake, response-2 has no producer: interrupted
  C-->>B: response-2 interrupted
  Note over A: new attempt from the last save
  A->>C: turn-1 running on response-3, extends assistant-msg-1
  Note over B: drops response-2's unsaved output, subscribes response-3
  A->>C: response-3 ends
  A->>C: turn-1 settled, completed, messages [assistant-msg-1]
```

## Gateway and agent

Webhooks and WebSocket upgrades both go through the `ChannelGateway` in the Worker, which routes each to a conversation's agent. `publish` pushes turn statuses and transcript updates to each channel; the channel reads response output from Streams itself.

```mermaid
flowchart LR
  Slack((Slack)) -- webhook --> GW
  Telegram((Telegram)) -- webhook --> GW
  Browser((Browser)) <-- WebSocket --> GW
  TUI((TUI)) <-- WebSocket --> GW
  subgraph Worker
    GW["ChannelGateway<br/>verify, normalize, route"]
  end
  GW -- "receive(event, origin)" --> CH
  GW -- "WebSocket upgrade" --> WEB
  subgraph DO["Agent Durable Object: one conversation"]
    WEB[Web Channel] -- inbound events --> CH
    CH[Channels] -- "submit, abort,<br/>reset" --> AG["Agent harness<br/>sessions, transcripts"]
    AG -- "watch: session events" --> CH
    CH --- RS[("responses<br/>(Streams)")]
    CH --- SF[("surfaces,<br/>delivery state")]
    CH -- publish --> WEB
    CH -- publish --> SC[Slack Channel]
    CH -- publish --> TC[Telegram Channel]
    RS -. read .-> WEB
    RS -. read .-> SC
    RS -. read .-> TC
  end
  SC -- "stream, edit" --> Slack
  TC -- "send, edit" --> Telegram
```

## One turn on every surface

Every turn goes to every surface in the conversation. Slack and Telegram quote a message that came from another surface; the browser shows it as a user message.

```mermaid
sequenceDiagram
  participant S as Slack
  participant G as ChannelGateway
  participant C as Channels
  participant A as Agent
  participant T as Telegram
  participant B as Browser
  S->>G: webhook: message event-1
  G->>C: receive(event-1, origin: Slack thread)
  Note over C: the Slack thread joins the conversation
  C->>A: submit(input, operation event-1)
  C->>B: message event-1
  A->>C: run-start [event-1]
  Note over C: turn event-1 running on response-1
  C->>S: stream response-1
  C->>T: quote event-1, then stream response-1
  C->>B: response-1
  A->>C: turn-1 settled, awaiting input, messages [assistant-msg-1]
  Note over S,B: approval shown on every surface
  T->>G: webhook: approve
  G->>C: receive(approval response)
  C->>A: submit(tool answer, operation event-2)
  A->>C: message assistant-msg-1 with the approval answered
  Note over S,B: every surface marks the approval answered
  A->>C: run-start [event-2]
  Note over C: turn event-1 running on response-2, extends assistant-msg-1
  C->>S: continue the same Slack message
  C->>T: continue the same Telegram message
  C->>B: response-2
```
