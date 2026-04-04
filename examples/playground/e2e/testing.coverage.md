# Playground E2E Coverage

- Total scenarios from testing.md: **113**
- Implemented in manual Playwright specs: **100**
- Remaining generated fixme scenarios: **13**
- Coverage: **88.5%**

## By spec

- `manual/core.spec.ts` — 20 scenarios
- `manual/navigation-and-workflow.spec.ts` — 12 scenarios
- `manual/multi-agent-and-sql.spec.ts` — 12 scenarios
- `manual/connections-routing-readonly.spec.ts` — 15 scenarios
- `manual/chat-approval-retry-docs.spec.ts` — 27 scenarios
- `manual/schedule-email-codemode-error.spec.ts` — 14 scenarios

## By category

### Core Demos — 37/37 (100%)

- State Management: 9/9 (100%)
- Callable Methods: 7/7 (100%)
- Streaming RPC: 4/4 (100%)
- Scheduling: 4/4 (100%)
- Connections: 4/4 (100%)
- SQL Queries: 4/4 (100%)
- Routing Strategies: 5/5 (100%)

### Multi-Agent Demos — 16/16 (100%)

- Supervisor Pattern: 7/7 (100%)
- Chat Rooms: 7/7 (100%)
- Workers Pattern: 1/1 (100%)
- Pipeline Pattern: 1/1 (100%)

### Workflow Demos — 13/13 (100%)

- Workflow Simulation: 6/6 (100%)
- Approval Workflow: 7/7 (100%)

### Email Demos — 12/25 (48%)

- Receive Emails: 0/6 (0%)
- Secure Email Replies: 0/7 (0%)
- Readonly Connections: 6/6 (100%)
- Retries: 6/6 (100%)

### AI Demos — 7/7 (100%)

- AI Chat: 1/1 (100%)
- Client-Side Tools: 1/1 (100%)
- Codemode: 5/5 (100%)

### MCP Demos — 3/3 (100%)

- MCP Server: 1/1 (100%)
- MCP Client: 1/1 (100%)
- MCP OAuth: 1/1 (100%)

### Global UI Tests — 9/9 (100%)

- Dark Mode Toggle: 3/3 (100%)
- Sidebar Navigation: 3/3 (100%)
- Event Log Panel: 3/3 (100%)

### Error Scenarios — 3/3 (100%)

- Connection Failure: 1/1 (100%)
- Invalid Input: 2/2 (100%)

## Remaining uncovered scenarios

- `email-demos-receive-emails-test-1-connection` — Receive Emails / Connection — `/email/receive`
- `email-demos-receive-emails-test-2-local-dev-banner` — Receive Emails / Local Dev Banner — `/email/receive`
- `email-demos-receive-emails-test-3-stats-display` — Receive Emails / Stats Display — `/email/receive`
- `email-demos-receive-emails-test-4-receive-email-deployed-only` — Receive Emails / Receive Email (Deployed Only) — `/email/receive` [deployed-only]
- `email-demos-receive-emails-test-5-view-email-detail` — Receive Emails / View Email Detail — `/email/receive`
- `email-demos-receive-emails-test-6-close-email-detail` — Receive Emails / Close Email Detail — `/email/receive`
- `email-demos-secure-email-replies-test-1-connection` — Secure Email Replies / Connection — `/email/secure`
- `email-demos-secure-email-replies-test-2-inbox-outbox-tabs` — Secure Email Replies / Inbox/Outbox Tabs — `/email/secure`
- `email-demos-secure-email-replies-test-3-toggle-auto-reply` — Secure Email Replies / Toggle Auto-Reply — `/email/secure`
- `email-demos-secure-email-replies-test-4-receive-email-with-auto-reply-deployed-only` — Secure Email Replies / Receive Email with Auto-Reply (Deployed Only) — `/email/secure` [deployed-only]
- `email-demos-secure-email-replies-test-5-view-signed-reply` — Secure Email Replies / View Signed Reply — `/email/secure`
- `email-demos-secure-email-replies-test-6-secure-reply-routing-deployed-only` — Secure Email Replies / Secure Reply Routing (Deployed Only) — `/email/secure` [deployed-only]
- `email-demos-secure-email-replies-test-7-clear-emails` — Secure Email Replies / Clear Emails — `/email/secure`
