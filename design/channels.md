# Channels design

Why `agents/channels` is shaped the way it is, and what we decided against.

This document records decisions and reasoning only. It deliberately describes no
API, so nothing in it goes stale as the package changes. For what the package
currently does, read [`docs/agents/channels.md`](../docs/agents/channels.md).

## The core decision: Channels is stateless

Channels authenticates and normalizes provider input, chooses an application
route, and delivers output. It owns no storage, no scheduler, no outbox, no
retries, and no deduplication. Every durability concern belongs to the
application.

The reason is ownership, not minimalism. An application that handles messages
already needs somewhere durable to put them — an Agent, a Durable Object, a
queue, a workflow, a database — and that store is where its own domain state
lives. A messaging library that keeps a second, private store of intents,
attempts, receipts, and preferences ends up competing with the first: two
records of the same conversation, two ideas of what was delivered, and no clear
answer about which one is true after a crash. It also fixes deployment topology,
because durability inside the library means the library needs Durable Object
storage, which means a simple integration cannot run in a plain Worker.

So the module's job is not to provide durability but to make
application-owned durability _possible_: identities that stay stable across
redelivery and rerouting, outcomes that are honest about what actually happened,
and destinations that are plain data an application can persist and use later.
The obligations this places on callers are written down as a durability contract
in the Channels reference, because a guarantee nobody reads is not a guarantee.

### What we rejected

- **Keeping the durable Router.** The original Router required Durable Object
  storage and a scheduler, and owned an outbox, retry backoff, ingress receipts,
  provider-reference indexes, approval settlement tombstones, and delivery
  preferences. It was genuinely useful, and it duplicated what durable callers
  already have. It also never delivered exactly-once ingress — a crash between
  the callback and its receipt write replays the callback anyway — so the
  guarantee it appeared to offer was not one it could keep.
- **Hiding durability in each provider adapter.** This produces inconsistent
  guarantees per provider, duplicates storage logic, and makes it impossible to
  say which layer owns retries and idempotency.
- **A durable wrapper alongside the stateless core.** Not rejected, deferred. A
  `DurableChannelRouter` implementing an outbox and inbox around the stateless
  core stays possible, but must not ship until a concrete consumer proves the
  interface. Speculatively adding it would re-import every problem above.

## Decisions that follow

### Routing is application policy, attached to each Channel

Each Channel carries a `route` function that turns a normalized event into an
opaque application string, or declines the event. Routing happens after
authentication and normalization, so adapters need no knowledge of application
structure, and the application needs no knowledge of provider payloads.

Declining is spelled with an explicit null rather than by returning nothing, so
that an accidental fallthrough in a route function cannot silently drop
messages, and so an absent route stays distinguishable from a deliberate ignore.
Adapters may discard protocol noise — bot echoes, edit events, joins, and other
provider chrome — but not authenticated human messages merely because they do
not look relevant. Direct-message, mention, and thread relevance are application
policy, so valid messages must reach routing along with the authenticated raw
payload needed to decide.

_Rejected:_ a Router-level routing table, which puts application policy in library
configuration; adapters evaluating their own routes, which would deny the
application the raw payload at the moment it decides; and adapter-level relevance
filters that silently discard input below the routing seam.

### Identity links are explicit, and visible while routing

Channels never infers that two identities belong to the same person. Address
matching and display-name matching are unsafe, so linking must be explicitly
performed by the application itself.

An application that _has_ recorded a link should still be able to act on it at
the moment it matters, so a Router can be given a lookup function and routes can
ask it whether the actor is a known user. The application owns the store; the
Router only asks. This is what lets a personal agent see a Slack and an email from
the same person land in the same conversation without guesswork.

_Rejected:_ automatic identity resolution; and a Router-owned identity store,
which would reintroduce exactly the state this design removes.

### Channels select their own inbound work

A Channel is offered an input and returns nothing if it is not interested. The
Router tries each configured Channel in order and takes the first that claims it.
Declining and rejecting are different: a Channel that owns a request but finds a
bad signature answers with its own error response.

This replaced a split model in which the Router matched HTTP by path itself while
email Channels answered a separate predicate. One rule covers both, adapters can
match on anything they like rather than only a path, and there is no Router-side
matching that can disagree with the checks an adapter performs anyway. Selection
exists to distinguish configured Channels that could claim the same input — for
example webhook paths or explicitly configured email mailboxes — not to decide
whether the application cares about an event after a Channel has claimed it.

_Accepted costs:_ configuration order becomes significant, and the Router can no
longer detect two Channels mounted on the same path.

### A destination is self-describing data

A surface names the configured Channel that can reach it, so an application can
store one and use it later without also remembering which object produced it.
The Router stamps that key, because a Channel does not know the name it was
configured under. Composite destinations (try these in order, send to all of
these) are then ordinary surfaces resolved recursively by ordinary Channels
that the Router installs.

Channels have no implicit default destination. In a real conversation the
interesting destination is a particular person on whichever channel currently
reaches them, which a channel-wide default cannot express; and an application
that wants a fixed destination can persist a surface of its own.

_Rejected:_ pairing a surface with a Channel at the call site, which is just a
surface missing a field; and having the Router offer a surface to each Channel
until one claims it, because surfaces resemble each other closely enough that
mis-delivery through the wrong configured instance would be silent, while an
unknown key fails loudly. We also dropped a separate provider tag, accepting
that stored data is no longer interpretable without the configuration that
created it, in exchange for a single unambiguous identifier.

_Consequence:_ configured channel keys are durable identifiers. Renaming one
orphans every surface and identity persisted under the old name.

### Outbound attempts are singular and honestly reported

One `deliver` call is one provider attempt, and the result distinguishes
confirmed delivery, confirmed failure, and genuine uncertainty. Uncertainty is
the interesting case: after a timeout or a crash mid-send, nobody can say
whether the recipient got the message, and a library that retries on the
caller's behalf turns that ambiguity into duplicate messages.

Only the caller knows whether a duplicate is worse than a miss, so only the
caller can decide to retry. This is the single largest residual risk in the
design, and it is a property of providers without idempotent send operations
rather than of this package.

_Rejected:_ automatic retries, and suppressing repeated sends by delivery id
inside the package, which would require the durable record we deliberately
do not keep.

### Interaction identifiers carry nothing

An approval request identifier is opaque. Encoding the requesting conversation
inside it makes the identifier a covert routing channel that silently breaks
when routing changes, and it invites treating the identifier as though it were
an authorization credential, which it is not.

Once decisions route by the same rules as messages, the identifier does not need
to carry routing at all: a decision made on any linked channel arrives at the
conversation that asked. The application settles it, and the first terminal
decision wins.

_Rejected:_ embedding the route in the identifier, and a Router-owned correlation
index, which is state again.

### Approval links are rendered, not hosted

Provider-native approvals round-trip an identifier through the provider's own
controls, so nothing else is needed. Provider-neutral approvals instead need a
public link, and a link needs hosting, a signing key, an expiry, and revocation
— all application concerns with application-specific policy. So a Channel
renders the links its caller supplies and verifies nothing on their behalf. A
Channel asked to request approval without them reports an honest failure rather
than inventing one.

A bare, predictable interaction identifier is not safe as a public approval URL.
