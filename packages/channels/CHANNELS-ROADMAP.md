# Cloudflare Channels incremental roadmap

Source vision: [Restoring Proximity with Cloudflare Channels](https://docs.google.com/document/d/1taUiFxP3siRX_NJEbLsG6vhEVnz2fSI9SSnRhkxvIRE/edit?tab=t.0)

This roadmap builds Channels as independently testable vertical slices. Delivery is **at least once with stable identities**; it does not attempt to promise exactly-once execution.

## Guiding model

Keep these concepts distinct from the beginning:

- **Submission**: the accepted inbound request.
- **Turn**: one logical invocation of an agent.
- **Delivery attempt**: one physical request made while delivering that turn.
- **Response emission**: output produced by the agent.
- **Channel delivery**: one attempt to send an emission to a destination.

A retry creates another delivery attempt, **not another turn**.

## Milestone 1: Durable inbound submission

Goal: an inbound request can be acknowledged quickly, stored once, and eventually submitted to an agent despite transient failures.

1. **Write the submission invariants**
   - Specify identifier ownership, idempotency semantics, state transitions, and acknowledgement semantics.
   - Done when duplicate and failure scenarios have unambiguous expected outcomes.
   - Defined in [SUBMISSION-INVARIANTS.md](./SUBMISSION-INVARIANTS.md).

2. **Define the minimal canonical submission envelope**
   - Include submission ID, idempotency key, agent target, payload, source, creation time, and optional conversation hint.
   - Do not attempt to normalize every channel format yet.
   - Defined in [SUBMISSION-ENVELOPE.md](./SUBMISSION-ENVELOPE.md).

3. **Define the submission state machine**
   - Use `pending → delivering → delivered`, plus `retrying`, `failed`, and `cancelled`; acceptance is the operation that atomically creates the initial `pending` state.
   - Define which transitions are legal and terminal.
   - Defined in [SUBMISSION-STATE-MACHINE.md](./SUBMISSION-STATE-MACHINE.md).

4. **Implement durable storage for a submission**
   - Persist the envelope before returning successful acceptance.
   - Add a storage-level test proving the record survives instance restart or eviction.
   - Implemented by [`SubmissionStore`](./src/storage/submission-store.ts), with forced-eviction coverage.

5. **Implement atomic idempotent acceptance**
   - Require adapters to derive globally unique keys from provider identity and authenticated application context.
   - Repeated submissions with the same key and payload return the original submission ID.
   - Implemented by [`SubmissionStore.accept()`](./src/storage/submission-store.ts).

6. **Reject idempotency-key payload conflicts**
   - Reusing a key with materially different input returns a deterministic conflict.
   - Add tests for equivalent and conflicting payloads.
   - Implemented by the payload-equivalence check in [`SubmissionStore.accept()`](./src/storage/submission-store.ts).

7. **Expose the submission acceptance endpoint**
   - Validate the envelope, persist it, and return an acknowledgement without waiting for the agent.
   - Return enough information to retrieve status later.
   - Implemented by [`createSubmissionRouter()`](./src/submission-endpoint.ts).

8. **Create one logical agent-delivery record**
   - Associate exactly one turn ID and delivery record with each accepted submission.
   - Prove duplicate acceptance cannot create a second logical turn.
   - Implemented by [`SubmissionStore.accept()`](./src/storage/submission-store.ts).

9. **Implement the first agent dispatch**
   - Send the canonical envelope to the selected agent.
   - Include stable submission and turn IDs in every request.
   - Implemented by [`AgentDispatcher`](./src/agent-dispatch.ts).

10. **Record individual delivery attempts**
    - Store attempt number, start and end time, outcome, and a bounded error description.
    - Keep attempts separate from the logical delivery record.
    - Implemented by [`AgentDeliveryCoordinator`](./src/agent-delivery-coordinator.ts) and [`SubmissionStore`](./src/storage/submission-store.ts).

11. **Add delivery timeouts**
    - Classify timeout separately from explicit rejection.
    - Ensure a timed-out attempt releases or expires its processing lease.
    - Implemented by [`AgentDeliveryCoordinator`](./src/agent-delivery-coordinator.ts): a timed-out dispatch records a `timeout` outcome and releases its claim into the retry schedule.

12. **Add retry classification**
    - Retry transient network errors, timeouts, and selected server errors.
    - Do not retry malformed input, authentication failures, or permanent agent rejection.
    - Implemented by [`classifyDispatchError` and `PermanentDispatchError`](./src/retry-classification.ts); hosts can inject a custom classifier.

13. **Add bounded exponential backoff**
    - Persist the next-attempt time and retry count.
    - Add jitter and make the schedule testable with an injected clock.
    - Implemented by [`retryDelayMs`](./src/delivery-policy.ts) and [`SubmissionStore`](./src/storage/submission-store.ts), with an injected clock and jitter source.

14. **Make retry scheduling durable**
    - Ensure retries still happen after the runtime is restarted or evicted.
    - Avoid relying only on in-memory timers.
    - Implemented by [`AgentDeliveryScheduler`](./src/delivery-scheduler.ts) over `SubmissionStore.listDueSubmissions()` / `nextDeliveryEventAt()`, with forced-eviction coverage.

15. **Protect dispatch with a lease**
    - Prevent concurrent workers or alarms from dispatching the same logical delivery simultaneously.
    - Define lease expiry and recovery behavior.
    - Implemented by [`SubmissionStore.beginAgentDeliveryAttempt()`](./src/storage/submission-store.ts) and `recoverExpiredLeases()`.

16. **Add agent-side deduplication guidance or contract**
    - Require agents to deduplicate using the stable turn ID.
    - Document that a lost acknowledgement can cause the same turn to be delivered again.
    - Defined in [AGENT-DELIVERY-CONTRACT.md](./AGENT-DELIVERY-CONTRACT.md).

17. **Add terminal failure and dead-letter behavior**
    - Stop after a configured attempt or age limit.
    - Preserve the submission and attempt history for inspection or replay.
    - Implemented by the per-cycle limits in [`DeliveryPolicy`](./src/delivery-policy.ts) and [`SubmissionStore`](./src/storage/submission-store.ts).

18. **Expose submission status**
    - Return current state, timestamps, attempt count, and terminal error without exposing sensitive payloads unnecessarily.
    - Implemented by [`SubmissionStore.getStatus()`](./src/storage/submission-store.ts) and the `GET /:submissionId` route in [`createSubmissionRouter()`](./src/submission-endpoint.ts).

19. **Add manual replay**
    - Permit an operator to retry a terminal delivery while retaining the same logical turn ID.
    - Record who or what initiated the replay.
    - Implemented by [`SubmissionStore.replay()`](./src/storage/submission-store.ts) with an audited replay ledger.

20. **Add an end-to-end fault test**
    - Simulate acceptance, dispatch failure, restart, retry, successful agent receipt, and duplicate inbound submission.
    - This is the completion gate for durable submission.
    - Implemented by [`end-to-end-fault.test.ts`](./src/tests/end-to-end-fault.test.ts).

At this point, Channels has its first meaningful product slice: **durable acceptance plus idempotent, at-least-once submission to an agent**.

## Milestone 2: A durable long-running turn protocol

Goal: agent execution can outlive the original request and report progress or completion reliably.

21. **Define the agent acknowledgement contract**
    - Distinguish “request received” from “turn completed.”
    - Decide what constitutes successful delivery to the agent.

22. **Add an authenticated callback capability**
    - Give the agent a scoped way to emit events for one turn.
    - Prevent callbacks from being used for another tenant or turn.

23. **Define the turn event envelope**
    - Include event ID, turn ID, sequence information, event type, content, and timestamp.

24. **Persist agent events idempotently**
    - Duplicate event IDs become no-ops.
    - Conflicting reuse of an event ID is rejected.

25. **Support a progress event**
    - Persist and retrieve nonterminal updates without treating them as final responses.

26. **Support a completion event**
    - Mark a turn complete atomically with its final event.
    - Reject or explicitly classify later terminal events.

27. **Support an agent failure event**
    - Preserve structured retryability and a safe user-facing error separately.

28. **Add turn cancellation**
    - Persist cancellation intent and expose it to the agent.
    - Define races between cancellation and completion.

29. **Add event ordering rules**
    - Decide whether ordering uses monotonic sequence numbers, causal references, or server-assigned order.
    - Handle duplicates and gaps deterministically.

30. **Expose turn history**
    - Return submission, delivery attempts, progress events, and terminal outcome as one timeline.

## Milestone 3: Durable outbound delivery

Goal: output from an agent is stored first and delivered to a destination with the same reliability guarantees as inbound work.

31. **Define an outbound emission envelope**
    - Include emission ID, turn ID, content, intended audience, and optional routing hints.

32. **Persist emissions before routing**
    - Agent callbacks succeed only after the emission has been durably accepted.

33. **Define the outbound delivery state machine**
    - Keep emission state separate from each destination's delivery state.

34. **Implement one simple outbound destination**
    - Start with an HTTP callback or test channel rather than Slack or email.
    - Demonstrate durable delivery independently of channel complexity.

35. **Add outbound delivery attempts and retries**
    - Reuse the same retry vocabulary and observability model as inbound delivery.

36. **Add destination-side idempotency**
    - Supply a stable delivery ID to adapters and downstream services where supported.

37. **Add outbound dead-letter and replay**
    - Preserve the emission and destination so an operator can retry safely.

38. **Add an inbound-to-outbound end-to-end test**
    - Inbound acceptance → agent retry → progress → completion → outbound retry → destination receipt.

This completes the document's first major promise: **a durable protocol for long-running agent turns, in both directions**.

## Milestone 4: Shared message language

Goal: channels share a useful agent-oriented vocabulary without collapsing to plain text.

39. **Define the versioned message container**
    - Support ordered content parts and unknown-part preservation.

40. **Add the `text` part**
    - Specify plain text versus Markdown semantics and safe rendering behavior.

41. **Add the `media` or attachment part**
    - Use durable references with MIME type, filename, size, and access policy.

42. **Add the `link` part**
    - Represent label, URL, and optional preview metadata explicitly.

43. **Add the `action` part**
    - Represent approvals or choices independently of a channel's button format.

44. **Add the `table` part**
    - Define columns, rows, labels, and fallback text without embedding presentation details.

45. **Define degradation rules**
    - Every rich part must have a deterministic fallback for less capable channels.

46. **Create a capability description**
    - Allow each adapter to declare supported part types, limits, and interaction features.

47. **Add rendering contract tests**
    - Feed one canonical message through multiple synthetic capability profiles and snapshot the result.

## Milestone 5: First real channel

Goal: validate the abstractions against an actual messaging platform.

48. **Define the channel adapter interface**
    - Separate authentication, inbound parsing, acknowledgement, rendering, sending, and error classification.

49. **Implement inbound parsing for one channel**
    - Preserve the original provider message ID and raw metadata alongside normalized content.

50. **Derive the idempotency key from provider identity**
    - Document how edits, retries, threaded replies, and repeated webhooks are treated.

51. **Return the provider acknowledgement immediately**
    - Prove agent latency does not affect webhook acknowledgement latency.

52. **Implement outbound text delivery**
    - Map delivery IDs and provider response IDs into the durable delivery record.

53. **Implement threading**
    - Route responses to the provider thread associated with the inbound message.

54. **Implement rich-part rendering and fallback**
    - Add only the capabilities supported by this first channel.

55. **Add adapter contract tests**
    - Run duplicate webhook, retry, rate-limit, malformed payload, and provider outage scenarios.

56. **Add a second channel adapter**
    - Choose a structurally different channel, such as email, to expose false assumptions in the interface.

## Milestone 6: Identity and conversation resolution

Goal: channel-specific senders and threads resolve to shared people and conversations.

57. **Define `ChannelAddress`**
    - Represent provider, account or workspace, channel-specific user identity, and destination address.

58. **Define a stable principal**
    - Keep the person or service identity distinct from channel addresses.

59. **Persist verified address-to-principal links**
    - Record verification method, issuer, time, and revocation state.

60. **Resolve inbound addresses to principals**
    - Unknown senders should produce an explicit unresolved identity, not an invented user.

61. **Define the conversation entity**
    - Give it stable ownership, participants, creation source, and lifecycle state.

62. **Map provider threads to conversations**
    - Repeated messages in the same provider thread resolve consistently.

63. **Add configurable conversation creation rules**
    - Decide when a direct message, email thread, or call creates a new conversation.

64. **Support cross-channel conversation continuation**
    - Permit a verified address on another channel to resolve to the same person and conversation.

65. **Represent non-human principals**
    - Agent-to-agent submissions carry explicit service identity and delegated authority.

66. **Add multi-participant conversations**
    - Model participants and roles without assuming every participant can see every message.

67. **Add conversation-resolution audit output**
    - Explain which rules and identity links produced the chosen principal and conversation.

This completes the second major promise: **identity-aware routing between agents and people**.

## Milestone 7: Authorization

Goal: the system can make safe decisions in ambiguous or multi-user contexts.

68. **Define the authorization context passed to agents**
    - Include authenticated principal, participants, channel, tenant, and relevant claims.

69. **Separate authentication confidence from authorization**
    - A known phone number or email address should not automatically grant permissions.

70. **Add a policy hook before agent dispatch**
    - Permit, deny, or require additional verification before invoking the agent.

71. **Add a policy hook before outbound delivery**
    - Prevent sensitive output from being sent to an inappropriate channel or participant set.

72. **Add interactive approval as a canonical action**
    - Bind approval to principal, turn, action, expiry, and single-use nonce.

73. **Add an audit trail for authorization decisions**
    - Record policy version, inputs, result, and human approvals without logging unnecessary content.

## Milestone 8: Routing and agent-initiated communication

Goal: responses can choose channels based on context, capabilities, preference, and failure.

74. **Define a destination candidate**
    - Combine principal, channel address, capabilities, and availability.

75. **Implement explicit routing**
    - An agent can request a specific verified destination.

76. **Implement reply-to-origin routing**
    - Default a response to the channel and conversation that produced the inbound turn.

77. **Add recency-based routing**
    - Prefer the most recently active suitable channel when no destination is explicit.

78. **Add user preferences**
    - Support allowed channels, quiet hours, and prohibited communication modes.

79. **Add capability-based routing**
    - Choose destinations that can support required actions or content.

80. **Add deterministic routing explanations**
    - Persist candidate rejection reasons and the rule that selected the destination.

81. **Add delivery failover**
    - After a terminal or classified channel failure, select an eligible alternative destination.

82. **Prevent uncontrolled failover loops**
    - Bound attempts across channels and retain one routing history.

83. **Support agent-initiated turns**
    - Create a turn without an inbound submission while preserving actor, reason, and authorization context.

84. **Add scheduling for initiated communication**
    - Allow future delivery while reevaluating preferences and authorization at send time.

## Milestone 9: Production hardening

Goal: make the full system operable, secure, and evolvable.

85. **Add correlated structured logging**
    - Correlate submission, turn, event, emission, routing decision, and delivery attempt IDs.

86. **Add operational metrics**
    - Track acceptance latency, queue age, attempt count, success rate, terminal failures, and channel latency.

87. **Add stuck-work detection**
    - Detect expired leases, overdue retries, incomplete turns, and emissions without active delivery.

88. **Add operator inspection tooling**
    - Show the complete timeline while redacting content and credentials appropriately.

89. **Add replay authorization and audit controls**
    - Restrict replay, cancellation, and destination override operations.

90. **Add retention and deletion policies**
    - Independently govern raw provider payloads, normalized content, delivery history, and audit records.

91. **Add payload size and attachment limits**
    - Reject or externalize oversized data before it threatens durable storage limits.

92. **Add per-tenant quotas and backpressure**
    - Prevent one tenant or channel from exhausting dispatch capacity.

93. **Add schema-version compatibility tests**
    - Ensure older durable records and envelopes continue to be readable after upgrades.

94. **Add migration tooling**
    - Make durable-state migrations resumable, observable, and safe to retry.

95. **Run a complete failure-injection suite**
    - Cover duplicate webhooks, crashes after persistence, lost acknowledgements, stale leases, rate limits, callback duplication, provider outage, and failover.

96. **Publish the protocol and adapter documentation**
    - Document guarantees, non-guarantees, lifecycle diagrams, idempotency responsibilities, and adapter conformance requirements.

## Recommended milestone boundaries

Avoid building identity or rich rendering before proving the reliability core:

1. **Days 1–20:** durable submission to an agent
2. **Days 21–30:** long-running agent events
3. **Days 31–38:** durable outbound delivery
4. **Days 39–47:** shared message vocabulary
5. **Days 48–56:** real channel adapters
6. **Days 57–67:** identity and conversations
7. **Days 68–73:** authorization
8. **Days 74–84:** routing, failover, and initiated communication
9. **Days 85–96:** production hardening

The critical early design choice is to make the **turn ID stable across every retry** and record physical attempts separately. That gives Channels an honest at-least-once system and avoids encoding an impossible exactly-once guarantee into the rest of the design.
