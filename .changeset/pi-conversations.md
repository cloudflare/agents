---
"agents": minor
---

The Pi harness renames "sessions" to "conversations", to align with Pi:

| Before                                                     | After                                                     |
| ---------------------------------------------------------- | --------------------------------------------------------- |
| `PiSession`, `PiSessions` and the other `PiSession*` types | `PiConversation`, `PiConversations` and `PiConversation*` |
| `harness.session(id)`, `harness.sessions`                  | `harness.conversation(id)`, `harness.conversations`       |
| The `session` option and result field                      | `conversation`                                            |
| `ROOT_SESSION`                                             | `ROOT_CONVERSATION`                                       |
| `openPiSessionStore`, `PiSessionStoreOptions`              | `openPiStorage`, `PiStorageOptions`                       |
