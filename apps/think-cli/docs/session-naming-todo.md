# Session Naming — Design TODO

Sessions need human-readable names. The remote agent gives us an opaque session
ID. We store a local mapping of ID → name so users don't have to remember UUIDs.

---

## Problem

```
$ think resume
  1. a]3f8e2b1-4c7d-9a0e-b5f6-1234567890ab  (2 hours ago)
  2. 7c9d4e5f-8a1b-2c3d-4e5f-6789abcdef01  (yesterday)
  3. b2e1f3a4-5d6c-7e8f-9a0b-cdef12345678  (3 days ago)
```

Nobody can tell these apart. We need:

```
$ think resume
  1. auth-refactor          (2 hours ago)
  2. mcp-reconnection-bug   (yesterday)
  3. a]3f8e2b1              (3 days ago)    ← unnamed, shows truncated ID
```

---

## Local Session Store

A JSON file at `~/.config/think/sessions.json`. This is purely local metadata —
the remote agent owns the real session state.

```typescript
interface SessionEntry {
  id: string;          // full session ID from the remote agent (source of truth)
  name?: string;       // optional human-readable name, set by user
  createdAt: string;   // ISO timestamp
  lastAccessedAt: string;
  remoteUrl: string;   // which agent endpoint this session lives on
}

interface SessionStore {
  sessions: SessionEntry[];
}
```

Example file:

```json
{
  "sessions": [
    {
      "id": "a3f8e2b1-4c7d-9a0e-b5f6-1234567890ab",
      "name": "auth-refactor",
      "createdAt": "2026-03-17T10:30:00Z",
      "lastAccessedAt": "2026-03-19T08:15:00Z",
      "remoteUrl": "https://agent.example.com"
    },
    {
      "id": "7c9d4e5f-8a1b-2c3d-4e5f-6789abcdef01",
      "name": "mcp-reconnection-bug",
      "createdAt": "2026-03-18T14:00:00Z",
      "lastAccessedAt": "2026-03-18T16:45:00Z",
      "remoteUrl": "https://agent.example.com"
    },
    {
      "id": "b2e1f3a4-5d6c-7e8f-9a0b-cdef12345678",
      "createdAt": "2026-03-16T09:00:00Z",
      "lastAccessedAt": "2026-03-16T11:30:00Z",
      "remoteUrl": "https://agent.example.com"
    }
  ]
}
```

---

## Rules

1. **The ID is the source of truth.** All API calls to the remote agent use the
   full session ID. Names are never sent to the remote — they're local-only
   display sugar.

2. **Names are optional.** An unnamed session shows a truncated ID (first 8
   chars) in listings.

3. **Names must be unique** within the local store. If a user tries to set a
   duplicate name, reject with a clear error.

4. **Names are simple strings.** Lowercase, hyphens, underscores, numbers.
   No spaces, no special chars. Keep it slug-like so it works as a CLI argument.

   Regex: `^[a-z0-9][a-z0-9_-]{0,62}$`

5. **Resume by name or ID.** Both work:
   ```
   think resume auth-refactor
   think resume a3f8e2b1
   ```
   Name match takes priority. If ambiguous (a name that looks like a truncated
   ID), name wins.

---

## `/name` Command

Set or change the name of the current session.

```
/name auth-refactor        # set name
/name                      # show current name (or "unnamed")
/name --clear              # remove name, revert to ID
```

### Behavior

- Can only be run inside an active session
- Validates the name format (slug rules above)
- Checks for uniqueness against other sessions
- Writes to the local session store immediately
- Updates the displayed session label in the UI (header/footer/status bar)

### Implementation

```typescript
function handleNameCommand(args: string, currentSessionId: string): void {
  const store = loadSessionStore();
  const entry = store.sessions.find(s => s.id === currentSessionId);

  if (!entry) {
    // Session exists on remote but not in local store yet — create entry
    store.sessions.push({
      id: currentSessionId,
      name: undefined,
      createdAt: new Date().toISOString(),
      lastAccessedAt: new Date().toISOString(),
      remoteUrl: getCurrentRemoteUrl(),
    });
  }

  if (!args || args.trim() === "") {
    // Show current name
    print(entry?.name ?? `(unnamed — id: ${currentSessionId})`);
    return;
  }

  if (args.trim() === "--clear") {
    entry.name = undefined;
    saveSessionStore(store);
    print("Name cleared.");
    return;
  }

  const name = args.trim();

  // Validate format
  if (!/^[a-z0-9][a-z0-9_-]{0,62}$/.test(name)) {
    error("Name must be lowercase alphanumeric with hyphens/underscores, 1-63 chars.");
    return;
  }

  // Check uniqueness
  const conflict = store.sessions.find(s => s.name === name && s.id !== currentSessionId);
  if (conflict) {
    error(`Name "${name}" is already used by session ${conflict.id.slice(0, 8)}`);
    return;
  }

  entry.name = name;
  saveSessionStore(store);
  print(`Session named: ${name}`);
}
```

---

## Resume Flow

```typescript
async function resume(identifier?: string): Promise<void> {
  const store = loadSessionStore();

  if (!identifier) {
    // Show interactive list
    const choices = store.sessions
      .sort((a, b) => b.lastAccessedAt.localeCompare(a.lastAccessedAt))
      .map(s => ({
        label: s.name ?? s.id.slice(0, 8),
        value: s.id,
        hint: timeAgo(s.lastAccessedAt),
      }));

    identifier = await promptSelect("Pick a session:", choices);
  }

  // Resolve: try name first, then ID prefix, then full ID
  const session =
    store.sessions.find(s => s.name === identifier) ??
    store.sessions.find(s => s.id.startsWith(identifier)) ??
    store.sessions.find(s => s.id === identifier);

  if (!session) {
    error(`No session found matching "${identifier}"`);
    return;
  }

  // Always connect using the full ID
  const messages = await fetchSessionMessages(session.remoteUrl, session.id);

  // Update last accessed
  session.lastAccessedAt = new Date().toISOString();
  saveSessionStore(store);

  // Continue session...
  await startSession(session.id, messages);
}
```

---

## Display Rules

| Context | What to show |
|---------|-------------|
| Session list (`think resume`) | Name if set, else truncated ID (8 chars) |
| Active session header/footer | Name if set, else truncated ID |
| Logs / debug output | Always full ID |
| API calls to remote | Always full ID |
| `/name` output | Name + full ID |

---

## Auto-naming (Future)

After the first user message in a new session, we could auto-generate a name
from the conversation (like how Claude Code generates branch names). Low
priority — manual `/name` is fine for v1.

```typescript
// Future: auto-name after first exchange
async function maybeAutoName(sessionId: string, firstMessage: string): Promise<void> {
  const store = loadSessionStore();
  const entry = store.sessions.find(s => s.id === sessionId);
  if (entry?.name) return; // already named

  const name = slugify(firstMessage.slice(0, 60));
  // ... deduplicate, validate, save
}
```

---

## Implementation Order

1. **Session store** — `sessions.json` read/write with the `SessionEntry` type
2. **Resume by name or ID** — resolution logic in the resume flow
3. **`/name` command** — set/show/clear
4. **Display** — show names in session lists and UI chrome
5. **Auto-naming** — later, if manual naming feels tedious
