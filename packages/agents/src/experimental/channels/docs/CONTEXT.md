# Channels

The shared language between agent harnesses (the AI SDK and pi harnesses today; AIChatAgent, Think, Codex or opencode later) and the interfaces people use to talk to them (browser, Slack, Telegram, email, voice). Every agent reaches Channels through the shared harness interface.

## Conversations

**Channel**:
An interface that shows conversations to people, such as Slack, Telegram, Email or the Web Channel. Each Channel turns its platform's events into inbound events and shows responses on its surfaces. Clients of a Channel, such as the Pi TUI or the AI SDK chat transport over the Web Channel, are not Channels.
_Avoid_: Adapter (a harness adapter is the vendor translation layer), provider, messenger

**Conversation**:
The unit that owns exactly one transcript.
_Avoid_: Session, lane, thread

**Surface**:
Where a conversation appears on one interface, such as a Slack thread or a web page. A conversation can have many surfaces.
_Avoid_: Channel (for the location), destination

**Follow**:
What a surface does with the one conversation it shows. A web surface can follow another conversation after creating or forking one; a Slack thread or Telegram chat always follows the same conversation.
_Avoid_: Bind, switch, attach

**Participant**:
A person or client acting in a conversation. A participant may be connected through several tabs or devices at once; the shared vocabulary never names an individual connection.
_Avoid_: User (when several people share a conversation), connection, tab

## Inbound events

**Inbound event**:
Something a participant did that the agent receives: a message, a tool result, an approval response, a cancel, or a conversation operation.
_Avoid_: Command

**Cancel**:
An inbound event asking the agent to stop a turn. The turn settles as aborted, whether it was queued, running or awaiting input.
_Avoid_: Stop, abort (as the event name)

**Message**:
An inbound event carrying participant input. Whether it steers the running turn or waits for the next one is the harness's policy.

**Tool answer**:
A tool result or approval response, submitted to the harness as an operation of its own. The harness decides whether it is wanted: a client tool's result is taken only from the participant whose message started the turn, and the first answer wins. A refused answer leaves the turn as it was.
_Avoid_: Steer (as an event kind), prompt

**Conversation operation**:
An inbound event that acts on a conversation rather than in it: create, fork or reset. The agent decides which it supports, and each surface is told which it may send. Slack and Telegram surfaces send none.
_Avoid_: Session operation, command

**Create**:
A conversation operation that starts a new, empty conversation. The surface that sent it follows the new conversation.

**Fork**:
A conversation operation that starts a new conversation with the transcript so far. The surface that sent it follows the fork; other surfaces stay on the original.
_Avoid_: Branch, clone

**Reset**:
A conversation operation that starts a conversation over, keeping its id, optionally carrying a handoff note into the new context. Every surface showing the conversation starts again from an empty snapshot, then sees the new context's messages.
_Avoid_: Clear, new conversation

## Turns

**Turn**:
Everything the agent does from an inbound message until it is quiescent, including every model call and tool call in between. A conversation has at most one running turn, but any number of turns may be awaiting input. A turn starts as one harness operation; each tool answer that continues it is another operation, aliased to the turn. Messages that steer a running turn get their own turns, which share its response.
_Avoid_: Operation, run, request

**Turn status**:
One of queued, running or settled. A settled turn has an outcome: completed, failed, aborted, or awaiting input. Channels settles a turn as awaiting input when its operation completes with a tool call still unanswered. Only a turn awaiting input can run again, as a continuation, or be aborted.

**Continuation**:
The part of a turn that resumes when a tool result or approval response arrives for a turn settled as awaiting input.
_Avoid_: Continuation turn

**Attempt**:
One try at producing a turn. A new attempt starts from what the harness has already saved to the transcript, and replaces only the earlier attempt's unsaved output.
_Avoid_: Retry (as a noun)

**Step**:
One model call plus the tool calls it produced, as in the AI SDK. Used sparingly; the boundary does not depend on it.

## Output

**Conversation snapshot**:
The current view of a conversation: the harness session's transcript plus every turn that is queued, running or awaiting input.
_Avoid_: Hydration payload, state sync

**Response**:
One streamed, replayable run of agent output within a turn. It either ends, closed by its producer, or is interrupted, because its producer is gone. How the turn went is never a property of the response.
_Avoid_: Delivery stream, reply, operation

## Harnesses

**Harness**:
An agent loop that keeps its own transcripts behind the shared harness interface (`submit`, `abort`, `wait`, `reset`, `watch`, and session create, fork and list), such as `AiSdkHarness` or the pi harness's adapter. It is the only way an agent connects to Channels: `Channels.forHarness` serves each harness session as one conversation with the same id. The harness's words (session, operation, run) stay in harness-facing code.
_Avoid_: Session (outside harness-facing code)

**Harness adapter**:
Code that puts a vendor's own harness, such as `PiHarness`, behind the shared interface. It knows nothing about Channels setup; `Channels.forHarness` knows nothing about the vendor.
