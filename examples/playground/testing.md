# Playground Testing Guide

This document describes how to test every feature in the Agents SDK Playground. Each section covers a demo page with specific test steps and expected results.

## Prerequisites

1. Start the dev server: `npm run start`
2. Open http://localhost:5173 in your browser
3. Verify the home page loads with the feature grid

---

## Core Demos

### State Management (`/core/state`)

Tests real-time state synchronization between server and clients.

#### Test 1: Connection Status

- **Action**: Navigate to `/core/state`
- **Expected**: Connection status shows "Connected" with a green dot

#### Test 2: Counter Increment

- **Action**: Click the **+1** button
- **Expected**:
  - Counter value increases by 1
  - Event log shows `call → increment()` followed by `result ←`
  - "Current State" JSON updates with new counter value

#### Test 3: Counter Decrement

- **Action**: Click the **-1** button
- **Expected**: Counter value decreases by 1

#### Test 4: Set Counter (Server)

- **Action**: Enter `42` in the number input, click **Set (Server)**
- **Expected**:
  - Counter changes to 42
  - Log shows `call → setCounter(42)` and `result ←`

#### Test 5: Set Counter (Client)

- **Action**: Enter `100` in the number input, click **Set (Client)**
- **Expected**:
  - Counter changes to 100
  - Log shows `setState →` (client-side update, no server call)

#### Test 6: Add Item

- **Action**: Type "Test Item" in the New Item input, click **Add**
- **Expected**:
  - Item appears in the Items list
  - Items count increments

#### Test 7: Remove Item

- **Action**: Click **Remove** next to an item
- **Expected**: Item disappears from the list

#### Test 8: Reset State

- **Action**: Click the red **Reset** button
- **Expected**: Counter returns to 0, items list clears

#### Test 9: Multi-Tab Sync

- **Action**: Open the same URL in a new tab, modify state in one tab
- **Expected**: Both tabs show the same state (real-time sync)

---

### Callable Methods (`/core/callable`)

Tests the `@callable` decorator and RPC functionality.

#### Test 1: Math Operations

- **Action**: Enter `5` and `3`, click **add(5, 3)**
- **Expected**:
  - Log shows `call → { method: "add", args: [5, 3] }`
  - Result shows `8`

#### Test 2: Multiply

- **Action**: Click **multiply(5, 3)**
- **Expected**: Result shows `15`

#### Test 3: Echo

- **Action**: Type "Hello World", click **Echo**
- **Expected**: Log shows result `"Hello World"`

#### Test 4: Async Operation

- **Action**: Set delay to `2000`, click **slowOperation(2000)**
- **Expected**:
  - Takes ~2 seconds to complete
  - Result shows "Completed after 2000ms"

#### Test 5: Error Handling

- **Action**: Type "Something broke", click **Throw Error**
- **Expected**:
  - Event log contains "Something broke"
  - Last Result shows `Error: Something broke`

#### Test 6: Get Timestamp

- **Action**: Click **getTimestamp()**
- **Expected**: Returns current ISO timestamp string

#### Test 7: List Methods

- **Action**: Click **listMethods()**
- **Expected**:
  - Visible "Available Methods" card appears on the page
  - List includes `add`, `multiply`, `echo`, `getTimestamp`, `slowOperation`, `throwError`, and `listMethods`

---

### Streaming RPC (`/core/streaming`)

Tests streaming responses from agent to client.

#### Test 1: Stream Numbers

- **Action**: Set count to `10`, click **Stream 10 numbers**
- **Expected**:
  - Chunks appear one by one: `{"number":1}`, `{"number":2}`, etc.
  - Log shows multiple `chunk ←` entries
  - Final result shows `{"total":10}`

#### Test 2: Countdown with Delay

- **Action**: Set countdown to `5`, click **Countdown from 5**
- **Expected**:
  - Numbers stream in with ~500ms delay between each
  - Shows "5...", "4...", "3...", "2...", "1...", "Liftoff!"
  - Takes approximately 2.5 seconds total

#### Test 3: Stream with Error

- **Action**: Set "Error after" to `3`, click **Error after 3 chunks**
- **Expected**:
  - First 3 chunks arrive successfully
  - Error entry appears in log
  - Stream terminates

#### Test 4: Stream Starts Successfully

- **Action**: Start a stream
- **Expected**:
  - Stream starts successfully
  - Chunks or stream events appear
  - Final result appears when the stream completes

#### Test 5: Button State During Stream

- **Action**: Start a stream
- **Expected**:
  - Stream starts successfully
  - Chunks or stream events appear
  - Final result appears when the stream completes

---

### Scheduling (`/core/schedule`)

Tests delayed and recurring task scheduling.

#### Test 1: One-Time Task

- **Action**: Set delay to `5` seconds, enter a message, click **Schedule Task**
- **Expected**:
  - "Active Schedules" shows the new schedule
  - After 5 seconds, log shows `schedule_executed ←` with the message

#### Test 2: Recurring Task

- **Action**: Set interval to `10` seconds, enter a label, click **Schedule Recurring**
- **Expected**:
  - Schedule appears in Active Schedules
  - Every 10 seconds, log shows `recurring_executed ←`

#### Test 3: Cancel Task

- **Action**: Click **Cancel** next to an active schedule
- **Expected**:
  - Schedule disappears from Active Schedules
  - No more executions occur

#### Test 4: Refresh Schedules

- **Action**: Click **Refresh** link
- **Expected**: Active Schedules list updates

---

### Connections (`/core/connections`)

Tests WebSocket connection management and broadcasting.

#### Test 1: Connection Count

- **Action**: Navigate to `/core/connections`
- **Expected**: Connected Clients shows `1`

#### Test 2: Multi-Tab Count

- **Action**: Click **Open New Tab** (or manually open another tab to same URL)
- **Expected**:
  - Both tabs update to show `2` connected clients
  - Log shows `connection_count ← 2`

#### Test 3: Broadcast Message

- **Action**: Type a message, click **Broadcast**
- **Expected**:
  - Message appears in "Received Broadcasts" on ALL connected tabs
  - The broadcasted message text is visible alongside the received entry

#### Test 4: Tab Close

- **Action**: Close one of the tabs
- **Expected**: Remaining tab updates to show `1` connected client

---

### SQL Queries (`/core/sql`)

Tests direct SQL interaction with agent's SQLite database.

#### Test 1: List Tables

- **Action**: Navigate to `/core/sql`
- **Expected**: Tables list shows internal tables (e.g., `cf_agents_state`, `cf_agents_schedules`)

#### Test 2: View Table Schema

- **Action**: Click on a table name (e.g., `cf_agents_state`)
- **Expected**:
  - Schema card shows columns, types, and nullability
  - Query input updates to `SELECT * FROM cf_agents_state LIMIT 10`

#### Test 3: Execute Query

- **Action**: Click **Execute**
- **Expected**: Results card shows query results as JSON

#### Test 4: Insert Custom Data

- **Action**: Enter a key (e.g., "test-key") and value (e.g., "test-value"), click **Insert**
- **Expected**:
  - Record appears in the Custom Data list below
  - Tables list now includes `playground_data`

---

### Routing Strategies (`/core/routing`)

Tests different agent naming patterns.

#### Test 1: Per-User Strategy

- **Action**:
  1. Note your User ID (e.g., "user-abc123")
  2. Open a new tab with the same User ID
- **Expected**:
  - Both tabs connect to the same agent instance
  - Connected Clients shows `2`

#### Test 2: Change User ID

- **Action**: Change User ID to something different
- **Expected**:
  - Agent Instance name changes
  - Connection count resets to `1` (you're now on a different agent)

#### Test 3: Shared Strategy

- **Action**: Select **Shared** strategy
- **Expected**:
  - Agent instance changes to `routing-shared`
  - All tabs with Shared strategy connect to the same agent

#### Test 4: Per-Session Strategy

- **Action**: Select **Per-Session** strategy
- **Expected**:
  - Each tab connects to a different agent (based on session ID)
  - Opening new tab creates new session = new agent

#### Test 5: Strategy Persistence

- **Action**: Change User ID, refresh the page
- **Expected**:
  - User ID persists (stored in localStorage)
  - Agent instance still reflects the persisted user ID after refresh

---

## Multi-Agent Demos

### Supervisor Pattern (`/multi-agent/supervisor`)

Tests the manager-child agent pattern using `getAgentByName()`.

#### Test 1: Connection

- **Action**: Navigate to `/multi-agent/supervisor`
- **Expected**: Connection status shows "Connected", stats show 0 children

#### Test 2: Create Child

- **Action**: Click **+ Create Child**
- **Expected**:
  - New child card appears with ID like `child-abc123`
  - Child card shows a bare counter value of `0`
  - Stats update: Children = 1, Total Counter = 0
  - Log shows `call → createChild("child-abc123")` and result

#### Test 3: Increment Single Child

- **Action**: Click **+1** on a child card
- **Expected**:
  - That child's counter increments
  - Total Counter in stats updates
  - Log shows `call → incrementChild("child-abc123")`

#### Test 4: Increment All

- **Action**: Create multiple children, click **+1 to All**
- **Expected**:
  - All children increment by 1
  - Total Counter updates to sum of all counters
  - Log shows `call → incrementAll()`

#### Test 5: Remove Child

- **Action**: Click the **×** button on a child card
- **Expected**:
  - Child disappears from the grid
  - Stats update accordingly

#### Test 6: Clear All

- **Action**: Click **+ Create Child**, then click **Clear All** button
- **Expected**:
  - All children removed
  - Stats reset to 0

#### Test 7: Persistence

- **Action**: Create children, refresh the page
- **Expected**:
  - Children are preserved (supervisor tracks IDs in state)
  - Stats match previous values

---

### Chat Rooms (`/multi-agent/rooms`)

Tests multi-agent chat with Lobby and Room agents.

#### Test 1: Lobby Connection

- **Action**: Navigate to `/multi-agent/rooms`
- **Expected**: Lobby shows "Connected", room list is empty or shows existing rooms

#### Test 2: Create Room

- **Action**: Type "General" in room name, click **Create**
- **Expected**:
  - Room appears in the list with 0 online
  - Log shows `call → createRoom("General")`

#### Test 3: Join Room

- **Action**: Click on a room in the list
- **Expected**:
  - Chat area shows room name
  - Room header shows "0 members" initially, then "1 members"
  - Log shows `join_room → General`

#### Test 4: Send Message

- **Action**: Type a message, press Enter or click **Send**
- **Expected**:
  - Message appears in chat area
  - Your messages appear on the right with dark background
  - Log shows `send → <message>`

#### Test 5: Multi-User Chat

- **Action**:
  1. Create a new room in this test
  2. Join that room
  3. Open a new tab on the same route
  4. In the new tab, set a different username, join the same room, and send messages from both tabs
- **Expected**:
  - Both users see each other's messages in real-time
  - Members list shows both usernames
  - The room remains visible in the lobby with an online count

#### Test 6: Leave Room

- **Action**: Click **Leave** button
- **Expected**:
  - Chat area returns to "Select a room to start chatting"
  - Member count decreases for that room

#### Test 7: Room Persistence

- **Action**: Refresh page
- **Expected**:
  - Rooms persist (tracked in LobbyAgent state)
  - Messages persist (stored in RoomAgent)

---

### Workers Pattern (`/multi-agent/workers`)

Documentation-only demo explaining fan-out parallel processing.

#### Test 1: Page Load

- **Action**: Navigate to `/multi-agent/workers`
- **Expected**:
  - Architecture diagram with ManagerAgent → Workers
  - "How It Works" explanation
  - Example code snippet
  - Use cases list

---

### Pipeline Pattern (`/multi-agent/pipeline`)

Documentation-only demo explaining chain of responsibility.

#### Test 1: Page Load

- **Action**: Navigate to `/multi-agent/pipeline`
- **Expected**:
  - Architecture diagram with linear agent chain
  - "How It Works" explanation
  - Example code snippet
  - Variations section (Linear, Branching, Saga, Async)
  - Considerations notes

---

## Workflow Demos

### Workflow Simulation (`/workflow/basic`)

Interactive demo that simulates multi-step workflow execution with automatic step progression.

#### Test 1: Connection

- **Action**: Navigate to `/workflow/basic`
- **Expected**: Connection status shows "Connected", no workflows running

#### Test 2: Start Workflow

- **Action**: Enter a workflow name (e.g., "Data Processing"), set step count to 4, click **Start Workflow**
- **Expected**:
  - Workflow appears in "Running" section
  - Visual step pipeline shows Step 1 as running (spinner icon)
  - Event log shows `startWorkflow →`, `workflow_started ←`

#### Test 3: Watch Step Progression

- **Action**: Wait and observe the workflow
- **Expected**:
  - Steps complete one by one (1-2 seconds each)
  - Completed steps show checkmark, current step shows spinner
  - Connection lines turn solid as steps complete
  - Event log shows `workflow_progress ←` for each step
  - When all steps complete, `workflow_complete ←` appears

#### Test 4: Start Multiple Workflows

- **Action**:
  1. Start a workflow named `Data Processing`
  2. Start a second workflow named `Email Notification`
- **Expected**:
  - Both workflows appear in the UI by name
  - Each progresses independently
  - Completed workflows move to History section

#### Test 5: Cancel Workflow

- **Action**: Start a workflow, then click the X button before it completes
- **Expected**:
  - Workflow status changes to "cancelled"
  - Workflow moves to History section
  - Event log shows `cancelWorkflow →`, `workflow_cancelled ←`

#### Test 6: Clear History

- **Action**: After some workflows complete, click **Clear** in the History section
- **Expected**:
  - Resolved workflows are removed
  - Running workflows remain
  - Event log shows `clearWorkflows →`, `cleared ←`

---

### Approval Workflow (`/workflow/approval`)

Interactive demo that simulates human-in-the-loop approval patterns.

#### Test 1: Connection

- **Action**: Navigate to `/workflow/approval`
- **Expected**: Connection status shows "Connected", no pending approvals

#### Test 2: Submit Approval Request

- **Action**: Enter a title and description, click **Submit Request**
- **Expected**:
  - Request appears in "Pending Approval" section with yellow indicator
  - Shows Approve and Reject buttons
  - Event log shows `requestApproval →`, `approval_requested ←`

#### Test 3: Use Quick Presets

- **Action**: Click one of the preset request buttons (e.g., "Deploy v2.0 to Production")
- **Expected**:
  - Title and description fields are populated
  - Can submit the preset request

#### Test 4: Approve Request

- **Action**:
  1. Click the **Deploy to Production** preset, then click **Submit Request**
  2. Click **Approve** on that pending request
- **Expected**:
  - Request moves to History with green indicator
  - Shows "Approved at [time]"
  - Event log shows `approve →`, `approval_approved ←`

#### Test 5: Reject Request

- **Action**:
  1. Create a pending request by filling **Title** and **Description** and clicking **Submit Request**
  2. Click **Reject** on that pending request
- **Expected**:
  - Reject reason input appears
  - After clicking "Confirm Reject", request moves to History with red indicator
  - Shows "Rejected at [time]" with reason
  - Event log shows `reject →`, `approval_rejected ←`

#### Test 6: Multiple Pending Requests

- **Action**: Submit 3-4 requests without approving
- **Expected**:
  - All appear in Pending Approval section
  - Can approve/reject each independently

#### Test 7: Clear History

- **Action**:
  1. Submit and approve `Deploy to Production`
  2. Submit and approve `Access Request - Admin Panel`
  3. Confirm History shows two resolved requests, then click **Clear** in History
- **Expected**:
  - Resolved requests are removed from History
  - Pending requests remain

---

## Email Demos

### Receive Emails (`/email/receive`)

Tests receiving emails via Cloudflare Email Routing. Requires deployment for real email testing.

#### Test 1: Connection

- **Action**: Navigate to `/email/receive`
- **Expected**: Connection status shows "Connected", empty inbox, stats show 0

#### Test 2: Local Dev Banner

- **Action**: Observe the page when running locally
- **Expected**: Warning banner indicates email features require deployment

#### Test 3: Stats Display

- **Action**: Observe the Stats panel
- **Expected**: Shows Inbox count and Total received count

#### Test 4: Receive Email (Deployed Only)

- **Action**: Send an email to `receive+demo@yourdomain.com`
- **Expected**:
  - Email appears in Inbox list
  - Stats update (Inbox +1, Total +1)
  - Log shows `state_update ←`

#### Test 5: View Email Detail

- **Action**: Click on an email in the Inbox
- **Expected**:
  - Detail panel shows subject, from, to, date
  - Email body displayed below
  - Headers expandable via details toggle

#### Test 6: Close Email Detail

- **Action**: Click the **×** button on the detail panel
- **Expected**: Detail panel closes

---

### Secure Email Replies (`/email/secure`)

Tests HMAC-signed email replies for secure routing.

#### Test 1: Connection

- **Action**: Navigate to `/email/secure`
- **Expected**: Connection status shows "Connected", Inbox/Outbox tabs visible, stats show 0

#### Test 2: Inbox/Outbox Tabs

- **Action**: Click between **Inbox** and **Outbox** tabs
- **Expected**: Tab content switches, counts shown in tab labels

#### Test 3: Toggle Auto-Reply

- **Action**: Toggle the "Auto-reply with signed headers" switch
- **Expected**:
  - Log shows `toggleAutoReply →`
  - Setting persists in agent state

#### Test 4: Receive Email with Auto-Reply (Deployed Only)

- **Action**: Send an email to `secure+demo@yourdomain.com` with auto-reply enabled
- **Expected**:
  - Email appears in Inbox
  - Signed reply appears in Outbox with green checkmark
  - Reply has "Re:" prefix in subject

#### Test 5: View Signed Reply

- **Action**: Switch to Outbox tab, click on a reply
- **Expected**:
  - Detail shows the reply body
  - Green "Signed" badge displayed
  - Note about X-Agent-\* headers shown

#### Test 6: Secure Reply Routing (Deployed Only)

- **Action**: Reply to a signed email from your email client
- **Expected**:
  - Reply is routed back to the same agent instance
  - Email shows lock icon indicating "Secure Reply"

#### Test 7: Clear Emails

- **Action**: Click **Clear all emails**
- **Expected**:
  - Both inbox and outbox are cleared
  - Log shows `clearEmails →`

---

### Email Setup (Deployment)

To test with real emails:

1. Deploy: `npm run deploy`
2. Set secret: `wrangler secret put EMAIL_SECRET`
3. Configure Cloudflare Dashboard → Email → Email Routing
4. Add routing rule for your domain to this Worker
5. Send emails to:
   - `receive+instanceId@yourdomain.com` for ReceiveEmailAgent
   - `secure+instanceId@yourdomain.com` for SecureEmailAgent

---

## Core Demos

### Readonly Connections (`/core/readonly`)

Tests read-only WebSocket connections that can observe but not modify state.

#### Test 1: Dual Panel Layout

- **Action**: Navigate to `/core/readonly`
- **Expected**: Two side-by-side panels — "Editor (read-write)" on the left, "Viewer (readonly)" on the right

#### Test 2: Editor Increment

- **Action**: Click **+1** on the Editor panel
- **Expected**:
  - Counter increases on BOTH panels (state syncs to viewer)
  - "Last updated by" shows the update source

#### Test 3: Viewer Blocked (Callable)

- **Action**: Click **+1** on the Viewer panel
- **Expected**: Error toast appears — readonly connections cannot call methods that write state

#### Test 4: Viewer Blocked (Client setState)

- **Action**: Click **+10** on the Viewer panel
- **Expected**: Error toast appears — client-side setState is also blocked for readonly connections

#### Test 5: Check Permissions (Always Allowed)

- **Action**: Click **Check Permissions** on the Viewer panel
- **Expected**: Info toast shows `canEdit = false` — non-mutating RPCs work on readonly connections

#### Test 6: Toggle Readonly

- **Action**: Uncheck the **Lock** checkbox on the Viewer panel
- **Expected**:
  - Badge changes to "Viewer (read-write)"
  - Viewer can now increment and modify state

---

### Retries (`/core/retry`)

Tests retry operations with exponential backoff and selective retry.

#### Test 1: Flaky Operation (Succeeds)

- **Action**: Set "Succeed on attempt" to `3`, click **Run Flaky Operation**
- **Expected**:
  - Log shows `Attempt 1...` and `Attempt 2...`
  - Result contains `Success on attempt 3`

#### Test 2: Flaky Operation (Exhausted)

- **Action**: Set "Succeed on attempt" to `10`, click **Run Flaky Operation**
- **Expected**:
  - Log shows multiple attempt entries
  - Final error contains `Transient failure on attempt 3`

#### Test 3: Selective Retry (Transient)

- **Action**: Set "Failures before success" to `2`, leave "Permanent error" unchecked, click **Run Filtered Retry**
- **Expected**:
  - Log shows `Attempt 1...` and `Attempt 2...`
  - Final result contains `Success on attempt 3`

#### Test 4: Selective Retry (Permanent)

- **Action**: Check **Permanent error**, click **Run Filtered Retry**
- **Expected**:
  - shouldRetry returns false immediately
  - No retries — error appears after first attempt

#### Test 5: Queue with Retry

- **Action**: Set "Max attempts" to `3`, click **Queue Task**
- **Expected**:
  - Task is queued (log shows queued ID)
  - Retry attempts stream in via log messages
  - Succeeds on last attempt

#### Test 6: Clear Logs

- **Action**: Click **Clear Logs**
- **Expected**: All log entries clear

---

## AI Demos

### AI Chat (`/ai/chat`)

This is a documentation-focused demo explaining `AIChatAgent`.

#### Test 1: Page Load

- **Action**: Navigate to `/ai/chat`
- **Expected**:
  - Empty state shows "Start a conversation"
  - Prompt suggestions mention weather or timezone
  - Code explanation includes "Create an AI chat agent" and "Connect with useAgentChat"

---

### Client-Side Tools (`/ai/tools`)

Documentation demo for client-side tool execution.

#### Test 1: Page Load

- **Action**: Navigate to `/ai/tools`
- **Expected**:
  - Tool legend shows Server, Client, and Approval badges
  - Empty state with "Try the tools" suggestions is visible
  - Message input and send controls are visible

---

### Codemode (`/ai/codemode`)

Tests AI code generation and execution using the CodeAct pattern.

#### Test 1: Connection

- **Action**: Navigate to `/ai/codemode`
- **Expected**: Connection status shows "Connected", empty state with "Try Codemode" prompt suggestions

#### Test 2: Send Message

- **Action**: Type "What is 17 + 25?" and press Enter
- **Expected**:
  - User message appears on the right
  - Assistant response includes the answer `42`
  - A completed "Ran code" tool card appears

#### Test 3: Tool Card Expansion

- **Action**: Type "What is 17 + 25?" and press Enter, then click the "Ran code" tool card toggle
- **Expected**:
  - Card expands to show Code, Result, and Console sections
  - Code section shows the generated JavaScript
  - Result shows `42`

#### Test 4: Streaming

- **Action**: Type "What is 17 + 25?" and press Enter
- **Expected**:
  - User message appears in the conversation
  - Assistant response includes `42`
  - The completed "Ran code" tool card is rendered

#### Test 5: Clear History

- **Action**: Type "What is 17 + 25?" and press Enter, then click the trash icon
- **Expected**: All messages clear, returns to the empty state with "Try Codemode"

---

## MCP Demos

### MCP Server (`/mcp/server`)

Documentation for creating MCP servers.

#### Test 1: Page Load

- **Action**: Navigate to `/mcp/server`
- **Expected**:
  - What is MCP explanation
  - Tools/Resources/Prompts feature cards
  - How It Works steps

---

### MCP Client (`/mcp/client`)

Documentation for connecting to MCP servers.

#### Test 1: Page Load

- **Action**: Navigate to `/mcp/client`
- **Expected**:
  - API method cards (addMcpServer, mcp.listTools, etc.)
  - Connection options code snippet

---

### MCP OAuth (`/mcp/oauth`)

Documentation for OAuth authentication with MCP.

#### Test 1: Page Load

- **Action**: Navigate to `/mcp/oauth`
- **Expected**:
  - OAuth flow steps listed
  - Server states table (not-connected, authenticating, etc.)
  - Client-side handling code snippet

---

## Global UI Tests

### Dark Mode Toggle

#### Test 1: Toggle Dark Mode

- **Action**: Click the theme toggle in the sidebar footer twice
- **Expected**:
  - `data-theme-preference` becomes `dark`
  - `data-mode` becomes `dark`

#### Test 2: Persistence

- **Action**: Set to Dark mode, refresh the page
- **Expected**:
  - `data-theme-preference` remains `dark`
  - `data-mode` remains `dark`

#### Test 3: System Preference

- **Action**: Set to System, emulate dark mode, then emulate light mode
- **Expected**:
  - `data-theme-preference` stays `system`
  - `data-mode` follows the emulated system preference

---

### Sidebar Navigation

#### Test 1: Category Collapse

- **Action**: Click on a category header (e.g., "CORE")
- **Expected**: Category collapses/expands

#### Test 2: Active State

- **Action**: Click on a demo link
- **Expected**:
  - Navigation moves to the selected demo route
  - The selected sidebar link has `aria-current="page"`

#### Test 3: External Links

- **Action**: Inspect the GitHub and Docs links in the sidebar footer
- **Expected**:
  - GitHub points to `https://github.com/cloudflare/agents`
  - Docs points to `https://developers.cloudflare.com/agents`
  - Both links use `target="_blank"`

---

### Event Log Panel (`/core/streaming`)

Present on all interactive demos (State, Callable, Streaming, Schedule, Connections, SQL, Routing, Readonly, Retry, Email Receive, Email Secure).

#### Test 1: Auto-Scroll

- **Action**: Click "Stream Numbers" and wait for the stream to complete
- **Expected**:
  - Event log contains `stream_start`
  - Event log contains `stream_done`

#### Test 2: Clear Logs

- **Action**: Click "Stream Numbers", then click "Clear logs"
- **Expected**: All log entries clear, shows "Waiting for events…"

#### Test 3: Log Entry Types

- **Action**: Click "Stream Numbers"
- **Expected**:
  - Event log shows an outgoing `stream_start` entry
  - Event log shows incoming `chunk` entries
  - Event log shows an incoming `stream_done` entry

---

## Error Scenarios

### Connection Failure (`/core/state`)

Manual validation only (`documentation-only`).

#### Test 1: Server Not Running

- **Action**: Stop the dev server, refresh the page
- **Expected**: Connection status shows "Connecting..." indefinitely

### Invalid Input (`/core/state`)

Manual validation only (`documentation-only`).

#### Test 1: Empty Item

- **Action**: Click Add with empty input
- **Expected**: Nothing happens (validation prevents empty items)

#### Test 2: Non-Numeric Counter

- **Action**: Enter "abc" in counter input, click Set
- **Expected**: Counter becomes `NaN` or 0 (depending on parseInt behavior)

---

## Performance Checks

### Large State

- **Action**: Add 100+ items via the State demo
- **Expected**:
  - No UI lag
  - State syncs correctly
  - JSON display remains responsive

### Rapid Operations

- **Action**: Click increment button rapidly (20+ times)
- **Expected**:
  - All operations complete
  - Final count is accurate
  - Log shows all calls
