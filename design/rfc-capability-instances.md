# RFC: more than one instance of a capability in a Durable Object

Status: accepted (24 Nov 2026). Not implemented yet.

Related:

- [durable-object-lifecycle.md](./durable-object-lifecycle.md): the Lifecycle, capabilities and the job queue.
- [rfc-slim-hosts.md](./rfc-slim-hosts.md): the shape rule this adds a case to.

## The problem

A capability passes a fixed id to `LifecycleCapability` (`super("streams")`), owns fixed table names (`cf_agents_streams`, `cf_agents_task_runs`, `cf_agents_session_messages`), fixed KV keys and a fixed job owner id, and `Lifecycle.use()` refuses a second capability with the same id.

So an object can have one `Streams`, one `Tasks` and one `Sessions`. That is a problem as soon as one capability is built on others. A harness such as `ThinkHarness` uses Tasks, Streams and Sessions to do its work. An app that installs the harness and also wants Streams for something of its own has two bad choices today: share the harness's rows, ids, tags and jobs, or go without. A library used inside an app has the same problem.

Two questions follow:

1. Is a harness a capability at all, once its rows live in the capabilities it is built on?
2. How do two instances of one capability share an object without meeting?

## The proposal

### A harness is a capability

The shape rule in [rfc-slim-hosts.md](./rfc-slim-hosts.md) says code is a capability when it owns storage or schedules work, and a plain module otherwise. This adds a third case: a harness (`ThinkHarness`, and the Pi and container harnesses) is a capability even when it owns no table and pushes no job, because it composes the capabilities that do into the one unit a host installs. It holds no storage of its own; every row lives in a capability it composes.

### A kind, an instance name, and an id

A capability has a kind, fixed by its class, and an optional instance name. Its id is the kind for the default instance and `kind/name` for a named one. Everything the capability touches is derived from that id by the base class:

| What               | Default instance                                           | Named instance `audit`                                             |
| ------------------ | ---------------------------------------------------------- | ------------------------------------------------------------------ |
| Capability id      | `streams`                                                  | `streams/audit`                                                    |
| Tables and indexes | `cf_agents_streams`, `idx_cf_agents_streams_tag` (today's) | `cf_agents_streams__n_audit`, `idx_cf_agents_streams_tag__n_audit` |
| KV keys            | `cf_agents:streams_schema_version` (today's)               | under `cf_agents:streams/audit:`                                   |
| Jobs               | owner `streams`, job ids as today                          | owner `streams/audit`, every job id prefixed with it               |
| Events             | `stream:opened`                                            | the same type, with `instance: "audit"`                            |
| Socket tags        | `streams:…`                                                | `streams/audit:…`                                                  |

```ts
import { DurableObject } from "cloudflare:workers";
import { Lifecycle } from "agents/lifecycle";

class MyAgent extends DurableObject<Env> {
  // Composes its own Tasks, Streams and Sessions, named after the harness.
  readonly think = new ThinkHarness({ model });
  // The app's own: the default instance, on the tables it has today.
  readonly streams = new Streams();
  readonly audit = new Streams({ name: "audit" });
  readonly lifecycle = Lifecycle.install(this)
    .use(this.think)
    .use(this.streams)
    .use(this.audit);
}
```

- Instances of one kind never see each other's rows, ids, lanes, tags or jobs. Ids are unique within an instance. Each instance lists, purges and migrates alone, and there is no API across instances.
- The default instance keeps today's tables, keys and job owner id. An app with one instance runs the same statements on the same tables, and nothing migrates. Rows written before instances existed are the default instance's and keep their ids.
- Index names are database-wide in SQLite, so an instance's indexes carry its suffix as its tables do; a fixed index name with `IF NOT EXISTS` would leave a second instance without its index.
- A job id is unique in the job queue whoever owns it, so an owner id alone does not keep two instances' jobs apart. The jobs handle a named instance gets prefixes every job id with the instance's id; the default instance's job ids are unchanged.
- A name matches `[a-z][a-z0-9-]{0,31}` and is checked at construction. A capability resolves its table names once and builds its statement text once; no run-time value reaches SQL text.
- `Lifecycle.use()` throws for a real duplicate, naming the kind and the instance.

### Composition

A composing capability constructs the instances it composes, named after itself, and declares them to the base class. `Lifecycle.use()` installs them first, then the composer, so a host writes one `.use()`. Names an app chooses and names a composer derives are in separate namespaces, so they cannot collide: an app's `new Streams({ name: "think-harness" })` is `streams/think-harness` on tables suffixed `__n_think_harness`, while the harness's own Streams is `streams/@think-harness` on tables suffixed `__c_think_harness`. `@` is not allowed in a name an app passes. A second harness named `support` has `streams/@think-harness-support`. A capability composed by a composed capability is named after its direct composer, so nesting repeats the rule.

A composer can be given an instance instead of building one. Then the host installs it. That is for a host whose released rows are already in the default tables and whose own API reads them, which keeps them where they are.

`ThinkHarness` composes its own Tasks (`tasks/@think-harness`, tables `cf_agents_task_runs__c_think_2dharness` and the rest): each operation is a run on the session's lane, and the open operations a released version kept in the harness store are carried forward into runs at start. A host can give it a Tasks instead (internal `tasks` option), which the host installs; the harness-backed Think does, with the Agent's default. Streams and Sessions are still the default instances' tables until Streams takes a name and the transcripts move.

### What is shared

Some things are one per object and are shared, not instanced: the physical alarm and the Lifecycle job queue (every job has an owner id), the object's sockets (one `WebSockets` accepts and dispatches; tags carry the id), keep-alive (holds are counted), and the object's name and routing.

### An instance that is no longer installed

Its tables and keys are kept. Its due jobs stay in the queue, where the job driver already keeps and retries a job whose owner is not installed, and the Lifecycle reports the missing id once per start. Dropping an instance's data is an explicit call, never something startup does.

### The rule for a capability author, and its check

The base class hands a capability its id, a storage handle that names its tables and prefixes its keys, and jobs, events and socket tags that are already its own. A capability never writes a table name or a KV key as a literal outside that handle, and never constructs a capability it depends on without declaring it.

Two checks hold the rule. A conformance test, registered by every capability, installs it as the default and as a named instance side by side, runs it, and then reads `sqlite_master`, every KV key and every job: the named instance must have touched nothing outside its own names, and the default must see nothing the named one wrote. A source check fails on a literal table name or key outside a capability's table declaration.

### Order

The mechanism in the Lifecycle and the base class first, changing no table. Then Tasks, Streams, and Sessions with Context each take a name, one PR each, with the conformance test, a test that rows from the released version open as the default instance, and numbers showing the default path costs what it did. Queue, Scheduler and the MCP client manager follow when something needs a second one.

## The alternatives

**A `channel` column in every key.** One table family per kind, with `PRIMARY KEY (channel, id)` and every statement filtered by channel. It is what the `durability` library does, and its semantics are the ones kept here (one instance per name, ids unique within it, old rows are the default, rows of an unattached instance are kept and reported). It was not chosen for the storage because every app would pay for it: each row carries the column, each index entry is longer, each statement has one more predicate, and SQLite cannot change a primary key in place, so every released table would be rebuilt once at startup. A missed predicate would also leak rows between instances.

**One instance that serves named scopes** (`streams.scope("audit")`). It needs the same column and rebuild, an app would have to be handed the harness's instance, and options that differ per owner (row budget, retention, batching) would have to be invented per scope.

**Pass the host's one instance to the harness and forbid a second.** Simple, and it was the first position. It fails the requirement: the app's streams and the harness's would be in one list, with one set of ids and tags, purged together.

## The decision

Accepted on 24 Nov 2026: a harness is a capability; a capability has a kind and an optional instance name; a table name per instance with the default instance unchanged; a composer builds its own named instances and can be given one. The `name` option on the constructors of capabilities that are already public is the one new public surface.
