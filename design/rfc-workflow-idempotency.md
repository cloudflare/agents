Status: proposed

# Active workflow idempotency keys

## The problem

`runWorkflow()` creates a Workflow instance before it writes the Agent's local
tracking row. Two requests can therefore both observe no active workflow, call
`runWorkflow()`, and create overlapping instances. Serializing the whole
operation with `blockConcurrencyWhile()` holds a Durable Object lock across an
external Workflow RPC and can reset the object when that RPC is slow.

Workflow instance IDs are not the right logical singleton key. Instances and
their platform state can be retained after completion, while callers need to
start a new instance as soon as the active run reaches a terminal state.

## The proposal

Add `RunWorkflowOptions.idempotencyKey`. Before the Workflow RPC, synchronously
insert the generated Workflow ID and idempotency key into Agent SQLite. A
partial unique index on `(workflow_name, idempotency_key)` covers non-terminal
rows. Durable Object input gates make that local claim atomic without holding a
lock across external I/O.

If another active row already owns the key, return its Workflow ID. When the
row becomes `complete`, `errored`, or `terminated`, it leaves the partial index
and a later call can claim the same logical key with a new Workflow instance
ID. Historical tracking and platform Workflow retention remain unchanged.

The key is additionally scoped by the Agent or sub-agent facet because each
facet has its own SQLite storage.

## Alternatives

- Query active workflows before creation: this leaves a time-of-check to
  time-of-use race.
- Use the idempotency key as the Workflow instance ID: retained Workflow IDs
  prevent starting the next generation with the same key.
- Wrap creation in `blockConcurrencyWhile()`: this holds a global Durable
  Object lock across external I/O and is subject to the callback deadline.
- Add queue, cancel, or replace policies now: these require durable pending
  payloads and lifecycle orchestration. They should build on this claim
  primitive in a separate concurrency-policy design.

## The decision

Pending review. The initial conflict behavior is `use existing`: concurrent
calls return the active Workflow ID. The API can grow a separate explicit
concurrency policy without changing the meaning of `idempotencyKey`.
