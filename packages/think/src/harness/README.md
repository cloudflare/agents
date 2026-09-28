# The harness-backed Think

Internal and experimental. `think.ts` is Think rebuilt on
`agents/harness/think`. `pnpm test:harness` runs Think's test suite against
it and records the score in `../../harness-compat.md`. When every test
passes, it replaces `../think.ts`.

## What must carry over

An agent that moves onto this class keeps its durable state. Work that was
in flight at the moment of the move (a running turn, a parked approval, a
queued submission, a recovery in progress) is allowed to die. Everything
below is not.

| Durable state                                                 | Storage                                                                              | Status                                                |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ----------------------------------------------------- |
| Transcript, compactions, attachments                          | `cf_agents_session_*`, default session `""`                                          | Same tables and handle                                |
| The agent's own schedules                                     | Agent's Scheduler (`cf_agents_jobs`)                                                 | Agent base class, unchanged                           |
| Agent state, MCP servers                                      | Agent base tables                                                                    | Agent base class, unchanged                           |
| Declared scheduled tasks                                      | `cf_think_scheduled_tasks`, jobs calling `_runDeclaredScheduledTask`                 | Not ported: must keep the table and the callback name |
| Config, client tool schemas, request body, skills fingerprint | `think_config` (`_think_config`, `lastClientTools`, `lastBody`, `skillsFingerprint`) | Not ported: must read the same keys                   |
| Workspace files                                               | `@cloudflare/shell` Workspace tables                                                 | Not ported: must construct `Workspace` the same way   |
| Messenger and channel subscriptions                           | `ThinkMessengerStateAgent` facet                                                     | Not ported                                            |

A feature ported from Think reads the tables Think wrote. It does not get
new ones.

Scheduler jobs the previous engine queued for in-flight work
(`_chatRecoveryRetry`, `_chatRecoveryContinue`,
`_cfRetryMessengerRecoveryDelivery`) complete without doing anything.
