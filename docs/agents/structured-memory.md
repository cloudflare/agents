# Structured Memory (Draft)

> **Draft for design review.** Nothing on this page is implemented yet. It
> describes the proposed developer-facing API so the design can be evaluated
> before implementation starts.

`agents/structured-memory` gives a model its own SQLite database for structured
records it keeps across turns and sessions, such as contacts it has met, tasks
it is tracking, or facts it has extracted from documents. The model creates and
changes the tables itself through tools.

The tools are available for the pi harness and the AI SDK.

## How it works

A structured memory is a SQLite database in a
[Durable Object facet](https://developers.cloudflare.com/dynamic-workers/usage/durable-object-facets/)
under your Durable Object. The facet has its own database, separate from your
object's `ctx.storage.sql`, so the model sees only the tables it created and
cannot read or change your object's tables, including the harness's own.

The model works with the database through `db_*` tools. It reads with SQL and
writes through structured tools such as `db_create_table` and `db_insert`.

```ts
import { DurableObject } from "cloudflare:workers";
import { createStructuredMemory } from "agents/structured-memory";
import { structuredMemoryTools } from "agents/structured-memory/ai-sdk";
import { AiSdkHarness } from "agents/harness/ai-sdk";
import { Lifecycle } from "agents/lifecycle";

// The facet runs this class, so the Worker entry must export it.
export { StructuredMemoryFacet } from "agents/structured-memory";

export class CrmAgent extends DurableObject<Env> {
  readonly crmMemory = createStructuredMemory(this.ctx);

  readonly harness = new AiSdkHarness({
    model,
    system: "Keep track of the people and companies the user mentions.",
    tools: structuredMemoryTools(this.crmMemory, {
      permissions: {
        // querying data and inspecting the schema are allowed by default
        query: "allow",
        describe: "allow",

        // grant permission to create tables, columns and rows
        createTable: "allow",
        addColumn: "allow",
        insert: "allow",

        // get approval to update/delete rows
        update: "ask",
        delete: "ask"

        // dropping tables is never allowed (default)
        // dropTable: "deny"
      }
    })
  });

  readonly lifecycle = Lifecycle.install(this).use(this.harness);
}
```

### Creating the database

`createStructuredMemory(ctx, options?)` returns a `StructuredMemory` object for
one database. Calling it does not touch storage. The facet and its SQLite
database are created the first time anything calls a method on the object, and
they persist until you delete them.

`name` selects the database. Each name is a separate facet with a separate
SQLite database. The default is `"default"`. Most agents will only need one:

```ts
readonly crmMemory = createStructuredMemory(this.ctx);
readonly scratch = createStructuredMemory(this.ctx, { name: "scratch" });
```

Tool names start with `db_` by default. To give one model the tools for more
than one database, set a different `prefix` for each, so the tool names do not
collide:

```ts
tools: {
  ...structuredMemoryTools(this.crmMemory, { prefix: "crm_", permissions }),
  ...structuredMemoryTools(this.scratch, { prefix: "scratch_", permissions })
}
```

With `prefix: "crm_"`, the tools are `crm_describe`, `crm_query`,
`crm_create_table`, and so on. The rest of this page uses the default `db_`.

### AI SDK harness

The AI SDK adapter returns a `ToolSet` keyed by tool name. Pass it to
`AiSdkHarness`, alone or merged with your other tools:

```ts
import { AiSdkHarness } from "agents/harness/ai-sdk";
import { structuredMemoryTools } from "agents/structured-memory/ai-sdk";

readonly harness = new AiSdkHarness({
  model,
  tools: {
    ...otherTools,
    ...structuredMemoryTools(this.crmMemory, {
      permissions: { createTable: "allow", insert: "allow", delete: "ask" }
    })
  }
});
```

A permission of `"ask"` sets `needsApproval` on that tool, so the call waits
for approval through the harness's standard flow.

### Pi harness

The pi adapter takes the same options and returns an array of pi tool
registrations:

```ts
import { structuredMemoryTools } from "agents/structured-memory/pi";

this.registry.install({
  name: "crm-memory",
  tools: structuredMemoryTools(this.crmMemory, {
    permissions: { createTable: "allow", addColumn: "allow", insert: "allow" }
  })
});
```

> **TODO:** pi does not support human approval of tool calls yet. Until it does, the pi adapter throws when any permission is `"ask"`.

### Calling it from your code

`StructuredMemory` has one method per tool. The tools call these methods, and
your code can call them too, for example to create a table before the model
first runs:

```ts
await this.crmMemory.createTable({
  table: "people",
  description: "People the user has mentioned.",
  columns: [{ name: "name", type: "TEXT", notNull: true }]
});

const { rows } = await this.crmMemory.query("SELECT count(*) AS n FROM people");
```

Permissions apply to the tools only. Calls from your code are not restricted.

## Tool reference

The structured write tools accept an optional `reason`: a short note from the
model on why it is making the change. With [history](#history-and-undo)
enabled, the reason is stored with the operation. Without history, it is
accepted and ignored, so tool calls have the same shape either way. `db_undo`
and `db_execute` do not take a `reason`, because neither adds an operation to
the history.

### `db_describe`

Returns the `CREATE` statement of every table and index. Table and column
descriptions are included as SQL comments:

```sql
CREATE TABLE people ( /* People the user has mentioned, one row per person. */
  name TEXT NOT NULL, /* Full name */
  email TEXT UNIQUE, /* Work email address */
  met_on TEXT /* ISO 8601 date the user first met them */
);
CREATE INDEX people_by_name ON people (name);
```

### `db_query`

Runs SQL with optional bound parameters and returns the resulting rows.

```json
{
  "sql": "SELECT name, email FROM people WHERE email LIKE ? ORDER BY name",
  "params": ["%@cloudflare.com"]
}
```

The query cannot change the database (see [Reads](#reads)). The SQL runs as
written: the tool does not add a `LIMIT`, so the model should write bounded
queries. To protect the model's context, cap tool result sizes in your harness.

### `db_create_table`

```json
{
  "table": "people",
  "description": "People the user has mentioned, one row per person.",
  "reason": "The user asked me to keep track of people they meet.",
  "columns": [
    {
      "name": "name",
      "type": "TEXT",
      "notNull": true,
      "description": "Full name"
    },
    {
      "name": "email",
      "type": "TEXT",
      "unique": true,
      "description": "Work email address"
    },
    {
      "name": "met_on",
      "type": "TEXT",
      "description": "ISO 8601 date the user first met them"
    }
  ]
}
```

Each column takes:

| Field         | Notes                                                                                                                                                                                                                       |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`        | Required.                                                                                                                                                                                                                   |
| `type`        | A SQLite type name such as `TEXT`, `INTEGER`, `REAL`, or `BLOB`. Other names, such as `DATETIME` or `BOOLEAN`, are accepted and follow SQLite's [type affinity](https://www.sqlite.org/datatype3.html#type_affinity) rules. |
| `primaryKey`  | At most one column.                                                                                                                                                                                                         |
| `notNull`     |                                                                                                                                                                                                                             |
| `unique`      |                                                                                                                                                                                                                             |
| `default`     | A literal: string, number, boolean, or `null`.                                                                                                                                                                              |
| `description` | Optional. Stored as a comment in the table's SQL.                                                                                                                                                                           |

A table without a primary key still has SQLite's implicit `rowid`, which the
model can query and use in `where` conditions.

### `db_add_column`

Adds one column to a table. It takes a table name and a column definition in
the same shape as `db_create_table`. SQLite's rules apply: the new column cannot
be a primary key or unique, and a `notNull` column needs a `default` unless the
table is empty.

```json
{
  "table": "people",
  "column": {
    "name": "company",
    "type": "TEXT",
    "description": "Current employer"
  },
  "reason": "The user has started mentioning where people work."
}
```

### `db_create_index`

```json
{
  "table": "people",
  "name": "people_by_name",
  "columns": ["name"],
  "unique": false,
  "reason": "Most lookups are by name."
}
```

### `db_insert`

Inserts one or more rows. Either every row is inserted or none is.

```json
{
  "table": "people",
  "rows": [
    { "name": "Ada Lovelace", "email": "ada@example.com" },
    { "name": "Grace Hopper" }
  ],
  "reason": "The user mentioned meeting Ada and Grace at a conference."
}
```

Returns the `rowid` of each inserted row.

### `db_update`

Sets column values on every row matching `where`, a SQL condition with bound
parameters:

```json
{
  "table": "people",
  "set": { "met_on": "2026-10-08" },
  "where": "email = ?",
  "params": ["ada@example.com"],
  "reason": "The user said they first met Ada today."
}
```

`where` is required. To update every row, the model must pass `"where": "true"`.
The condition can use any SQL expression, including subqueries. See
[Row conditions](#row-conditions) for how it is run. Returns the number of rows
changed.

### `db_delete`

Deletes every row matching `where`, with the same rules as `db_update`. Returns
the number of rows deleted.

```json
{
  "table": "people",
  "where": "met_on < ?",
  "params": ["2020-01-01"],
  "reason": "The user asked me to forget anyone they met before 2020."
}
```

### `db_drop_table`

Drops a table and all its rows.

```json
{
  "table": "old_contacts",
  "reason": "The user said this list is no longer needed."
}
```

A table that another table references with a foreign key cannot be dropped.
The tool returns an error naming the referencing tables, and the model must
drop those first.

### `db_drop_index`

Drops an index by name.

```json
{
  "index": "people_by_name",
  "reason": "Lookups are by email now."
}
```

### `db_undo`

Undoes the most recent operation and removes it from the history. It takes no
input. See [History and undo](#history-and-undo).

### `db_execute`

Runs any SQL, including writes and schema changes, with optional bound
parameters.

```json
{
  "sql": "UPDATE people SET email = lower(email)"
}
```

It exists as an escape hatch for things the structured tools cannot express. It
is disabled by default and you should avoid it where you can: it bypasses every
other permission (see [`db_execute`](#the-db_execute-escape-hatch) under
Security), and its changes are not recorded in the history, so they cannot be
undone.

## Security

The model can only act on the database through the tools you give it. Three
things limit what those tools can do: the facet's isolation, the split between
reads and writes, and the tool permissions.

### Isolation

Each structured memory is a separate SQLite database in its own facet. The
model cannot reach your Durable Object's tables, the harness's tables, another
structured memory, or another Durable Object's data, whatever SQL it writes.

### Reads

`db_query` takes SQL, because reads are where SQL is most useful: joins,
aggregates, and ad hoc filters. The query runs inside a transaction that is
always rolled back. If the SQL changed anything, whether by `INSERT`, `DROP`,
`ALTER`, or a second statement after a `SELECT`, the change is discarded and the
tool returns an error telling the model to use the write tools.

### Writes

Every write tool takes structured input, not SQL. The tool builds the statement:
identifiers are quoted, values are bound as parameters, and type names are
checked against SQLite's type name syntax.

The one exception is the `where` condition of `db_update` and `db_delete`,
described next.

### Row conditions

The `where` condition of `db_update` and `db_delete` is SQL, so the model can
select rows by any condition. The tool does not parse it. Instead, SQLite
checks that it is a single expression.

Each call runs in one transaction, in two steps:

1. Select the `rowid`s of the matching rows, under a column alias generated at
   random for this call:

   ```sql
   SELECT rowid AS "_w3f9c…" FROM "people" WHERE (email = ?)
   ```

2. Update or delete exactly those rows, passing the `rowid`s as one bound
   parameter:

   ```sql
   UPDATE "people" SET "met_on" = ? WHERE rowid IN (SELECT value FROM json_each(?))
   ```

Between the steps, the tool checks that the result of step 1 has exactly one
column, named with the random alias. When SQLite is given several statements,
it returns the result of the last one. If the condition smuggled in another
statement, such as `1); DELETE FROM other; SELECT rowid FROM people WHERE (1`,
the last statement comes from the model's text, which does not know the alias.
The check fails, the transaction is rolled back, and nothing the extra
statements did is kept.

The condition text only ever runs in the `SELECT` of step 1. The statement that
writes contains only SQL the tool built and bound values.

This needs no special handling for semicolons in data. A condition such as
`note = 'a; b'` or `note LIKE '%;%'` is a single expression and works normally.

### Tool Permissions

`permissions` sets a level for each operation:

| Level     | Effect                                                     |
| --------- | ---------------------------------------------------------- |
| `"allow"` | The model gets the tool and can call it freely.            |
| `"ask"`   | The model gets the tool, and each call waits for approval. |
| `"deny"`  | The model does not get the tool. This is the default.      |

`query` and `describe` default to `"allow"`. Every other operation not listed
is denied, so if a later release adds an operation, existing agents do not get
it until you grant it.

### The `db_execute` escape hatch

`db_execute` runs SQL as written, so granting an agent access to it effectively overrides the permissions of every other tool. A model with `db_execute` can drop tables while `dropTable` is denied.
It can also create triggers, which run on later inserts made through the
structured tools. If [history](#history-and-undo) is enabled, it can change or
drop the history too.

If you enable it, prefer `"ask"`, so a person sees each statement before it
runs.

## Durability and recovery

### Transactions

Every operation is one transaction in the facet. If a call is interrupted, for
example because the Durable Object was evicted, either all of its effect is
stored or none of it is.

### Replay in pi

`db_describe` and `db_query` are `replay: "safe"`, so pi runs an interrupted
call again when the session recovers. All other tools are `replay: "unsafe"`:
pi gives the model an interrupted result instead of repeating a write that may
already have been stored, and the model can query to check.

### History and undo

With `history` enabled, every operation is recorded and can be undone:

```ts
readonly crmMemory = createStructuredMemory(this.ctx, {
  history: { maxOperations: 200 }
});
```

Each operation gets an id. What is recorded depends on the operation:

| Operation           | Recorded                                                | Undo                         |
| ------------------- | ------------------------------------------------------- | ---------------------------- |
| Insert              | The `rowid` of each new row, by trigger                 | Deletes the rows             |
| Update              | Each changed row's previous values, by trigger          | Restores the previous values |
| Delete              | Each deleted row, by trigger                            | Re-inserts the rows          |
| Create table, index | The new object's name                                   | Drops it                     |
| Add column          | The column name                                         | Drops the column             |
| Drop table          | Nothing is dropped yet: the table is renamed and hidden | Renames it back              |
| Drop index          | The index definition                                    | Recreates it                 |

Row changes are captured by triggers that the structured tools add to each
table, so they record changes made from your code as well as by the model.

A hidden table keeps its rows, indexes, and triggers, so restoring it costs no
more than the rename. Undoing a table drop fails with an error if a table with
the same name has been created since.

Undo goes backwards in order. `db_undo` undoes the most recent operation and
removes it from the history. Undo is not itself recorded, so an undone
operation cannot be redone. From your code:

```ts
await this.crmMemory.history(); // recent operations, newest first
await this.crmMemory.undo(); // undo the most recent operation
await this.crmMemory.revertTo(opId); // undo every operation after opId
```

Each operation is stored with the `reason` passed to the tool or method, and
`history()` returns it:

```ts
const [latest] = await this.crmMemory.history();
// {
//   id: "op_42",
//   operation: "update",
//   table: "people",
//   reason: "The user said Ada changed jobs.",
//   rowsChanged: 1,
//   at: 1791449178000
// }
```

The history shows the reason next to each operation, so a person, or the model
deciding what to undo, can see why each change was made.

When the history exceeds `maxOperations`, the oldest operations are dropped and
can no longer be undone. Tables hidden by `db_drop_table` are deleted for real at
that point.

History has costs. Every changed row writes a history row, which roughly doubles
rows written for updates and deletes. Dropped tables keep using storage until
their operation leaves the history.

Changes made through `db_execute` are not recorded. The history triggers skip
row changes made outside a recorded operation. Undoing an earlier operation
restores the values it recorded, which overwrites any later `db_execute`
changes to the same rows. A `db_execute` statement can also change or drop the
history itself.

### Deleting the database

```ts
await this.crmMemory.destroy();
```

This deletes the facet and its SQLite database. The next method call starts
with an empty database.
