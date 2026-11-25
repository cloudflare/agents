# Streams

**Experimental.** Code: `packages/agents/src/streams/`. The decision record is [rfc-streams.md](./rfc-streams.md).

## How it works

`Streams` is a Lifecycle capability that keeps an ordered chunk log per stream: a stream row (`cf_agents_streams`: state, tag, metadata, final cursor) and its chunks in blocks (`cf_agents_stream_blocks`: `seq_from`, `seq_to`, a comma-joined body of chunk JSON). A direct `append` writes one chunk at once; the internal sync aperture's `appendJson` buffers chunks in memory and writes them as one block per flush, with the crash rule in [event-log.md](./event-log.md#batches-and-the-crash-rule). A cutover settles a stream, runs the caller's synchronous writes and deletes the stream's rows in one transaction.

Tags are an indexed, non-unique lookup key; stream ids are unique within an instance.

## Instances

`new Streams({ name })` is a second Streams in the same Durable Object, apart from the default (unnamed) one: its own streams, blocks, tag index and schema version ([rfc-capability-instances.md](./rfc-capability-instances.md)). The default keeps `cf_agents_streams`, `cf_agents_stream_blocks`, `idx_cf_agents_streams_tag` and `cf_agents:streams_schema_version` byte for byte. A named instance `audit` has the same names ending in `__n_audit` (`idx_cf_agents_streams_tag__n_audit`) and its key under `cf_agents:streams/audit:`. The names come from the Lifecycle's capability store, once, in the constructor, and are written into statement text, never bound and never built from input. A named instance starts at the current schema: schema v1's per-chunk table is only ever the default's. `open`, `read`, `status`, `list`, `delete` and the sync aperture see only their own instance.

## Memory

Per stream touched in the isolate: its write buffer (bounded by the batch limits), its newest block's position, and, for a trimmed stream, its stored totals. Each leaves on settle or delete.
