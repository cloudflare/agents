export const html = `<!doctype html>
<html>
<meta charset="utf-8"/>
<title>Agent Dashboard</title>
<style>
  :root {
    --bg:#0b1020; --fg:#dfe7ff; --muted:#a9b2cc;
    --ok:#2bbf6a; --warn:#eec643; --err:#ff4d4f; --info:#5aa7ff;
    --tool:#9b59b6; --model:#00c2a8; --pause:#f0ad4e;
    --card-bg: rgba(255, 255, 255, 0.05);
    --border-color: rgba(255, 255, 255, 0.1);
  }
  
  body { 
    font: 14px system-ui, sans-serif; 
    margin: 0; 
    padding: 0;
    background: linear-gradient(135deg, #0a0e1a 0%, #151929 100%);
    color: var(--fg);
    min-height: 100vh;
  }
  
  .container {
    max-width: 1400px;
    margin: 0 auto;
    padding: 20px;
  }

  .dashboard {
    display: grid;
    grid-template-columns: 280px 1fr;
    gap: 20px;
    align-items: flex-start;
  }

  .sidebar {
    display: flex;
    flex-direction: column;
    min-height: calc(100vh - 160px);
    gap: 12px;
  }

  .sidebar-header {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 12px;
  }

  .sidebar-header h3 {
    margin: 0;
    font-size: 18px;
  }

  .sidebar-header p {
    margin: 4px 0 0;
    color: var(--muted);
    font-size: 13px;
  }

  .sidebar-actions {
    display: flex;
    gap: 6px;
    align-items: center;
  }

  .sidebar-actions button {
    padding: 6px 10px;
    border-radius: 8px;
    border: 1px solid var(--border-color);
    background: rgba(255, 255, 255, 0.05);
    color: var(--fg);
    cursor: pointer;
    transition: background 0.2s, transform 0.2s;
  }

  .sidebar-actions button:hover {
    background: rgba(255, 255, 255, 0.12);
    transform: translateY(-1px);
  }

  .sidebar-actions button.primary {
    background: var(--info);
    color: white;
    border-color: var(--info);
  }

  .sidebar-actions button.primary:hover {
    background: #4a96e0;
  }

  .threads-list {
    flex: 1;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .thread-item {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 6px;
    padding: 10px 12px;
    border-radius: 10px;
    border: 1px solid var(--border-color);
    background: rgba(255, 255, 255, 0.04);
    color: var(--fg);
    text-align: left;
    cursor: pointer;
    transition: background 0.2s ease, border 0.2s ease, transform 0.2s;
  }

  .thread-item:hover {
    background: rgba(90, 167, 255, 0.12);
    border-color: var(--info);
    transform: translateX(2px);
  }

  .thread-item.active {
    border-color: var(--info);
    background: rgba(90, 167, 255, 0.18);
  }

  .thread-title {
    font-size: 14px;
    font-weight: 600;
    word-break: break-all;
  }

  .thread-meta {
    display: flex;
    gap: 10px;
    flex-wrap: wrap;
    color: var(--muted);
    font-size: 12px;
  }

  .threads-empty {
    text-align: center;
    padding: 28px 14px;
    border-radius: 12px;
    border: 1px dashed var(--border-color);
    background: rgba(255, 255, 255, 0.03);
    color: var(--muted);
    font-size: 13px;
  }

  .main-column {
    display: flex;
    flex-direction: column;
    gap: 20px;
  }

  .chat-card {
    display: flex;
    flex-direction: column;
  }

  .chat-header {
    display: flex;
    flex-wrap: wrap;
    gap: 16px;
    align-items: flex-end;
    justify-content: space-between;
  }

  .chat-header .input-group {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .chat-header label {
    font-size: 13px;
    color: var(--muted);
  }

  .run-summary {
    margin-top: 12px;
    display: flex;
    flex-wrap: wrap;
    gap: 12px;
    align-items: center;
  }

  .run-badge {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 4px 10px;
    border-radius: 999px;
    border: 1px solid var(--border-color);
    background: rgba(255, 255, 255, 0.08);
    font-size: 12px;
    font-weight: 600;
    text-transform: capitalize;
  }

  .run-badge.running {
    background: rgba(90, 167, 255, 0.15);
    border-color: var(--info);
    color: var(--info);
  }

  .run-badge.paused {
    background: rgba(240, 173, 78, 0.18);
    border-color: var(--warn);
    color: var(--warn);
  }

  .run-badge.completed {
    background: rgba(43, 191, 106, 0.18);
    border-color: var(--ok);
    color: var(--ok);
  }

  .run-badge.error {
    background: rgba(255, 77, 79, 0.18);
    border-color: var(--err);
    color: var(--err);
  }

  .run-meta {
    font-size: 13px;
    color: var(--muted);
  }

  .subagent-panel {
    margin-top: 12px;
    padding: 12px;
    border-radius: 10px;
    border: 1px solid var(--border-color);
    background: rgba(255, 255, 255, 0.03);
    display: none;
    flex-direction: column;
    gap: 10px;
  }

  .subagent-panel.visible {
    display: flex;
  }

  .subagent-panel h4 {
    margin: 0;
    font-size: 13px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--muted);
  }

  .subagent-items {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .subagent-item {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 10px 12px;
    border-radius: 8px;
    border: 1px solid var(--border-color);
    background: rgba(255, 255, 255, 0.06);
  }

  .subagent-item.active {
    border-color: var(--info);
    background: rgba(90, 167, 255, 0.16);
  }

  .subagent-title {
    font-size: 13px;
    font-weight: 600;
    word-break: break-word;
  }

  .subagent-status {
    font-size: 12px;
    color: var(--muted);
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }

  .subagent-actions {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
  }

  .subagent-actions button {
    padding: 5px 10px;
    border-radius: 6px;
    border: 1px solid var(--border-color);
    background: rgba(255, 255, 255, 0.08);
    color: var(--fg);
    cursor: pointer;
    transition: background 0.2s ease;
  }

  .subagent-actions button:hover {
    background: rgba(255, 255, 255, 0.16);
  }

  .subagent-report {
    font-size: 12px;
    color: var(--muted);
    white-space: pre-wrap;
  }

  .chat-transcript {
    background: rgba(5, 10, 21, 0.8);
    border: 1px solid var(--border-color);
    border-radius: 12px;
    padding: 16px;
    margin-top: 16px;
    min-height: 240px;
    max-height: 360px;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .chat-empty {
    text-align: center;
    color: var(--muted);
    padding: 40px 0;
  }

  .chat-message {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 12px;
    border-radius: 12px;
    border: 1px solid var(--border-color);
    max-width: 80%;
  }

  .chat-message.user {
    align-self: flex-end;
    background: rgba(90, 167, 255, 0.12);
    border-color: rgba(90, 167, 255, 0.4);
  }

  .chat-message.assistant {
    align-self: flex-start;
    background: rgba(43, 191, 106, 0.12);
    border-color: rgba(43, 191, 106, 0.35);
  }

  .chat-message.tool {
    align-self: flex-start;
    background: rgba(155, 89, 182, 0.12);
    border-color: rgba(155, 89, 182, 0.35);
    font-family: Monaco, Consolas, monospace;
  }

  .chat-role {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--muted);
  }

  .chat-content {
    font-size: 14px;
    line-height: 1.5;
    white-space: pre-wrap;
    word-break: break-word;
  }

  .tool-call {
    margin-top: 10px;
    border: 1px solid var(--border-color);
    border-radius: 8px;
    padding: 8px;
    background: rgba(255, 255, 255, 0.04);
    font-family: Monaco, Consolas, monospace;
    font-size: 12px;
  }

  .chat-input {
    margin-top: 16px;
    display: flex;
    gap: 12px;
    align-items: flex-start;
  }

  .chat-input textarea {
    flex: 1;
  }

  .chat-actions {
    margin-top: 12px;
    display: flex;
    justify-content: flex-end;
  }

  .grid-two {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
    gap: 20px;
  }
  
  .header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 24px;
    padding-bottom: 16px;
    border-bottom: 1px solid var(--border-color);
  }
  
  .header h1 {
    margin: 0;
    font-size: 24px;
    font-weight: 600;
    color: var(--fg);
  }
  
  .status-bar {
    display: flex;
    align-items: center;
    gap: 12px;
  }
  
  .status-indicator {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 4px 8px;
    border-radius: 999px;
    font-size: 12px;
    font-weight: 500;
  }
  
  .status-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
  }
  
  .status-indicator.connected { 
    background: rgba(43, 191, 106, 0.2);
    color: var(--ok);
  }
  .status-indicator.connected .status-dot { 
    background-color: var(--ok);
  }
  .status-indicator.disconnected { 
    background: rgba(255, 77, 79, 0.2);
    color: var(--err);
  }
  .status-indicator.disconnected .status-dot { 
    background-color: var(--err);
  }
  
  .card {
    background: var(--card-bg);
    border-radius: 12px;
    padding: 16px;
    margin-bottom: 16px;
    backdrop-filter: blur(10px);
    box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
    border: 1px solid var(--border-color);
  }
  
  .row { 
    display: grid; 
    grid-template-columns: 1fr auto; 
    gap: 8px; 
    align-items: center; 
    margin-bottom: 16px;
  }
  
  .full-width {
    grid-column: 1 / -1;
  }
  
  textarea, input { 
    width: 100%; 
    padding: 10px 12px;
    border-radius: 8px;
    border: 1px solid var(--border-color);
    background: rgba(255, 255, 255, 0.05);
    color: var(--fg);
    font-family: inherit;
  }
  
  textarea:focus, input:focus {
    outline: none;
    border-color: var(--info);
    box-shadow: 0 0 0 2px rgba(90, 167, 255, 0.2);
  }
  
  pre { 
    background: var(--bg); 
    color: var(--fg); 
    padding: 12px; 
    border-radius: 8px; 
    max-height: 500px; 
    overflow: auto; 
    word-wrap: break-word; 
    white-space: pre-wrap;
    border: 1px solid var(--border-color);
  }
  
  button { 
    padding: 8px 12px; 
    border-radius: 8px; 
    border: 1px solid var(--border-color); 
    background: rgba(255, 255, 255, 0.05);
    color: var(--fg);
    cursor: pointer;
    transition: all 0.2s ease;
  }
  
  button:hover {
    background: rgba(255, 255, 255, 0.1);
    transform: translateY(-1px);
  }
  
  button:active {
    transform: translateY(0);
  }
  
  button.primary {
    background: var(--info);
    color: white;
    border-color: var(--info);
  }
  
  button.primary:hover {
    background: #4a96e0;
  }
  
  button.danger {
    background: var(--err);
    color: white;
    border-color: var(--err);
  }
  
  button.danger:hover {
    background: #e04343;
  }
  
  .button-group {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
  }
  
  code { 
    white-space: pre-wrap; 
    font-family: Monaco, Consolas, monospace;
  }

  /* Graph area */
  .graph-wrap { 
    border:1px solid var(--border-color); 
    border-radius:10px; 
    padding:16px; 
    background: var(--card-bg);
    overflow:hidden; 
    height:650px;
    position: relative;
  }
  #graph { 
    display:block; 
    width: 100%;
    height: calc(100% - 32px);
    background:linear-gradient(180deg, #0a0e1a, #151929); 
    border-radius:8px;
    user-select: none;
    -webkit-user-select: none;
  }
  .legend { 
    display:flex; 
    gap:8px; 
    flex-wrap:wrap; 
    color:var(--muted); 
    font-size:12px; 
    margin-bottom: 12px;
  }
  .badge { 
    display:inline-flex; 
    align-items:center; 
    gap:6px; 
    padding:4px 8px; 
    border-radius:999px; 
    background: rgba(255, 255, 255, 0.05);
  }
  .dot { 
    width:10px; 
    height:10px; 
    border-radius:50%; 
    display:inline-block; 
  }
  .laneLabel { 
    font: 11px system-ui; 
    fill:var(--muted); 
    font-weight:600; 
  }
  .node-circle { 
    cursor:pointer; 
    transition:opacity 0.2s; 
  }
  .node-circle:hover { 
    opacity:1 !important; 
  }

  /* Modal */
  .modal { 
    display:none; 
    position:fixed; 
    top:0; 
    left:0; 
    width:100%; 
    height:100%; 
    background:rgba(0,0,0,0.7); 
    z-index:1000; 
    align-items:center; 
    justify-content:center; 
  }
  .modal.open { 
    display:flex; 
  }
  .modal-content { 
    background: linear-gradient(135deg, #1a1f36 0%, #0f1419 100%);
    color: var(--fg); 
    padding:24px; 
    border-radius:12px; 
    max-width:700px; 
    max-height:80vh; 
    overflow:auto; 
    position:relative; 
    box-shadow:0 10px 30px rgba(0,0,0,0.5);
    border: 1px solid var(--border-color);
  }
  .modal-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 16px;
    padding-bottom: 12px;
    border-bottom: 1px solid var(--border-color);
  }
  .modal-title { 
    margin:0; 
    font-size:18px; 
    color:var(--info); 
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .modal-close { 
    background: rgba(255, 255, 255, 0.1); 
    color: #fff; 
    border: none; 
    border-radius:6px; 
    padding:6px 12px; 
    cursor:pointer; 
    font-size:14px;
    transition: background 0.2s;
  }
  .modal-close:hover { 
    background: rgba(255, 255, 255, 0.2); 
  }
  .modal-json { 
    background:#050a15; 
    padding:16px; 
    border-radius:8px; 
    overflow:auto; 
    max-height:500px; 
    font:12px Monaco, monospace; 
    white-space:pre-wrap; 
    word-wrap:break-word; 
    overflow-wrap:break-word;
    border: 1px solid var(--border-color);
  }
  
  /* Notifications */
  .notification {
    position: fixed;
    bottom: 20px;
    right: 20px;
    padding: 12px 16px;
    border-radius: 8px;
    color: white;
    font-weight: 500;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
    z-index: 2000;
    opacity: 1;
    transition: opacity 0.3s ease;
  }
  
  .notification.success {
    background: var(--ok);
  }
  
  .notification.error {
    background: var(--err);
  }
  
  .notification.info {
    background: var(--info);
  }
  
  /* Keyboard shortcuts hint */
  .shortcuts-hint {
    font-size: 12px;
    color: var(--muted);
    margin-top: 8px;
  }
  
  .shortcut {
    display: inline-block;
    padding: 2px 4px;
    background: rgba(255, 255, 255, 0.1);
    border-radius: 4px;
    font-family: monospace;
    margin: 0 2px;
  }
  
  /* Responsive */
  @media (max-width: 1100px) {
    .dashboard {
      grid-template-columns: 1fr;
    }
    .sidebar {
      min-height: auto;
    }
  }

  @media (max-width: 768px) {
    .row {
      grid-template-columns: 1fr;
    }
    
    .header {
      flex-direction: column;
      align-items: flex-start;
      gap: 12px;
    }
    
    .graph-wrap {
      height: 400px;
    }
    
    .modal-content {
      max-width: 90%;
      padding: 16px;
    }
  }

  .zoom-controls {
    position: absolute;
    bottom: 12px;
    right: 12px;
    display: flex;
    gap: 6px;
    align-items: center;
    background: rgba(0, 0, 0, 0.3);
    border: 1px solid var(--border-color);
    padding: 6px 8px;
    border-radius: 8px;
    backdrop-filter: blur(6px);
  }
  .zoom-controls button {
    padding: 4px 8px;
  }
  .zoom-controls .zoom-pct {
    min-width: 48px;
    text-align: center;
    font-weight: 600;
    color: var(--muted);
  }

  .todos-summary {
      display:flex; gap:12px; flex-wrap:wrap; margin: 8px 0 12px;
      color: var(--muted); font-size: 13px;
    }
    .todo-pill {
      display:inline-flex; align-items:center; gap:6px;
      padding:4px 8px; border-radius:999px; border:1px solid var(--border-color);
      background: rgba(255,255,255,0.04); font-weight: 600;
    }
    .todo-pill.pending { color:#9ca3af; }
    .todo-pill.in_progress { color: var(--info); }
    .todo-pill.completed { color: var(--ok); }

    .todo-list { list-style:none; padding:0; margin:0; }
    .todo-item {
      display:flex; align-items:flex-start; gap:10px;
      padding:8px 10px; border:1px solid var(--border-color);
      border-radius:10px; margin-bottom:8px; background: var(--card-bg);
    }
    .todo-status {
      min-width: 10px; min-height:10px; border-radius:999px; margin-top:6px;
    }
    .todo-status.pending { background:#9ca3af; }
    .todo-status.in_progress { background: var(--info); }
    .todo-status.completed { background: var(--ok); }
    .todo-content { white-space:pre-wrap; word-break:break-word; }

    .files-grid {
      display:grid; grid-template-columns: 260px 1fr; gap:12px;
    }
    .files-list {
      border:1px solid var(--border-color); border-radius:10px;
      background: var(--card-bg); overflow:auto; max-height:420px;
    }
    .file-row {
      display:flex; align-items:center; justify-content:space-between;
      padding:8px 10px; cursor:pointer; border-bottom:1px solid var(--border-color);
    }
    .file-row:last-child { border-bottom: none; }
    .file-row:hover { background: rgba(255,255,255,0.06); }
    .file-name {
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
      font-size:12px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width: 180px;
    }
    .file-meta { font-size:12px; color: var(--muted); }
    .file-preview {
      background:#050a15; padding:12px; border:1px solid var(--border-color);
      border-radius:10px; max-height:420px; overflow:auto;
    }

    /* line numbers in preview */
    .ln { color:#64748b; user-select:none; margin-right:10px; display:inline-block; width:56px; text-align:right; }
    .code { white-space:pre; }
</style>
<body>
  <div class="container">
    <div class="header">
      <h1>Agent Dashboard</h1>
      <div class="status-bar">
        <div id="connectionStatus" class="status-indicator disconnected">
          <span class="status-dot"></span>
          <span>Disconnected</span>
        </div>
      </div>
    </div>
    
    <div class="dashboard">
      <aside class="card sidebar">
        <div class="sidebar-header">
          <div>
            <h3>Threads</h3>
            <p>Durable Object conversations</p>
          </div>
          <div class="sidebar-actions">
            <button id="btnRefreshThreads" title="Refresh threads">↻</button>
            <button id="btnNew" class="primary">New</button>
          </div>
        </div>
        <div class="threads-list" id="threadsList">
          <div class="threads-empty">No threads yet. Create one to get started.</div>
        </div>
      </aside>

      <div class="main-column">
        <div class="card chat-card">
          <div class="chat-header">
            <div class="input-group">
              <label for="threadId">Thread ID</label>
              <input id="threadId" placeholder="Select or create a thread…" />
            </div>
          </div>

          <div class="run-summary">
            <span class="run-badge" id="runStatusBadge">Idle</span>
            <span class="run-meta" id="runStep"></span>
            <span class="run-meta" id="runModel"></span>
          </div>

          <div id="subagentPanel" class="subagent-panel">
            <h4>Subagents</h4>
            <div id="subagentItems" class="subagent-items"></div>
          </div>

          <div class="chat-transcript" id="chatTranscript">
            <div class="chat-empty">Select a thread to load the conversation.</div>
          </div>

          <div class="chat-input">
            <textarea id="msg" rows="3" placeholder="Type a user message…"></textarea>
            <button id="btnSend" class="primary">Send</button>
          </div>

          <div class="chat-actions">
            <div class="button-group">
              <button id="btnApprove">Approve (HITL)</button>
              <button id="btnReject">Reject (HITL)</button>
              <button id="btnCancel" class="danger">Cancel Run</button>
              <button id="btnState">Refresh State</button>
            </div>
          </div>

          <div class="shortcuts-hint">
            Press <span class="shortcut">Ctrl+Enter</span> to send, <span class="shortcut">Ctrl+N</span> for new thread
          </div>
        </div>

        <div class="card graph-card">
          <div class="graph-wrap">
            <div class="legend">
              <span class="badge"><span class="dot" style="background:var(--model)"></span>Model</span>
              <span class="badge"><span class="dot" style="background:var(--tool)"></span>Tool</span>
              <span class="badge"><span class="dot" style="background:var(--ok)"></span>Completed</span>
              <span class="badge"><span class="dot" style="background:var(--warn)"></span>Paused</span>
              <span class="badge"><span class="dot" style="background:var(--err)"></span>Error</span>
              <span class="badge"><span class="dot" style="background:var(--info)"></span>Run Tick</span>
              <span class="badge">Dashed link = Subagent relation</span>
              <span class="badge" style="margin-left:auto;">💡 Click and drag to pan</span>
            </div>
            <svg id="graph"></svg>
            <div class="zoom-controls">
              <button id="zoomOut">-</button>
              <span class="zoom-pct" id="zoomPct">100%</span>
              <button id="zoomIn">+</button>
              <button id="zoomReset">Reset</button>
            </div>
          </div>
        </div>

        <div class="grid-two">
          <div class="card">
            <h3>Todos</h3>
            <div class="todos-summary" id="todosSummary"></div>
            <ul class="todo-list" id="todosList"></ul>
          </div>
          <div class="card">
            <h3>Files</h3>
            <div class="files-grid">
              <div class="files-list" id="filesList"></div>
              <pre class="file-preview"><code id="filePreview" class="code"></code></pre>
            </div>
          </div>
        </div>

        <div class="card">
          <h3>State</h3>
          <pre id="state"></pre>
        </div>
      </div>
    </div>
  </div>

  <!-- Event Details Modal -->
  <div id="modal" class="modal">
    <div class="modal-content">
      <div class="modal-header">
        <h3 class="modal-title" id="modalTitle">Event Details</h3>
        <button class="modal-close" id="modalClose">✕ Close</button>
      </div>
      <div class="modal-json" id="modalJson"></div>
    </div>
  </div>

<script>
const $ = (id)=>document.getElementById(id);
const S = $("state");
const G = $("graph");
const modal = $("modal");
const modalTitle = $("modalTitle");
const modalJson = $("modalJson");
const modalClose = $("modalClose");
const connectionStatus = $("connectionStatus");
const threadsListEl = $("threadsList");
const runStatusBadge = $("runStatusBadge");
const runStepLabel = $("runStep");
const runModelLabel = $("runModel");
const chatTranscript = $("chatTranscript");
const threadInput = $("threadId");
const subagentPanel = $("subagentPanel");
const subagentItems = $("subagentItems");
const btnRefreshThreads = $("btnRefreshThreads");

let mainThreadId = "";
let ws; // main ws
let selectedThreadId = "";
let latestThreads = [];
const extraThreads = new Map();

// --- Graph state ---
const palette = ["#2563eb","#16a34a","#9333ea","#ea580c","#0891b2","#b91c1c","#0ea5e9","#059669"];
const lanes = new Map(); // threadId -> { lane, color, ws?, nodes:[], lastNodeKey?:string }
const laneOrder = []; // threadIds in display order
const nodeMap = new Map(); // nodeKey -> {x,y,type,elCircle,elText,threadId}
const lastNodePerLane = new Map(); // lane -> nodeKey
const childSpawnMap = new Map(); // childId -> spawnNodeKey (in parent)
const firstNodeInLane = new Map(); // threadId -> first nodeKey
const lastNodeInLane = new Map(); // threadId -> last nodeKey
const margin = {left:100, top:40, xStep:140, yStep:110};
const arrowId = "arrowHead";
const pendingEdges = new Map();
const primingThreads = new Set();

// Pan/drag state
let panState = {
  isPanning: false,
  startX: 0,
  startY: 0,
  offsetX: 0,
  offsetY: 0
};
let graphGroup; // Main group element that gets transformed
let zoom = 1;
const minZoom = 0.5, maxZoom = 4;

function initSVG() {
  G.innerHTML = "";
  const defs = document.createElementNS("http://www.w3.org/2000/svg","defs");
  const marker = document.createElementNS("http://www.w3.org/2000/svg","marker");
  marker.setAttribute("id", arrowId);
  marker.setAttribute("viewBox","0 0 10 10");
  marker.setAttribute("refX","10"); marker.setAttribute("refY","5");
  marker.setAttribute("markerWidth","6"); marker.setAttribute("markerHeight","6");
  marker.setAttribute("orient","auto-start-reverse");
  marker.setAttribute("markerUnits","userSpaceOnUse"); // keep size stable on zoom
  const path = document.createElementNS("http://www.w3.org/2000/svg","path");
  path.setAttribute("d","M 0 0 L 10 5 L 0 10 z"); path.setAttribute("fill","#64748b");
  marker.appendChild(path); defs.appendChild(marker); G.appendChild(defs);
  
  // Create main group for all graph elements
  graphGroup = document.createElementNS("http://www.w3.org/2000/svg","g");
  graphGroup.setAttribute("id", "graphGroup");
  G.appendChild(graphGroup);
  
  // Reset pan state
  panState = { isPanning: false, startX: 0, startY: 0, offsetX: 0, offsetY: 0 };
  applyTransform();
}
initSVG();

function resetGraphState() {
  closeAllSockets();
  initSVG();
  lanes.clear();
  laneOrder.splice(0);
  nodeMap.clear();
  lastNodePerLane.clear();
  childSpawnMap.clear();
  firstNodeInLane.clear();
  lastNodeInLane.clear();
  pendingEdges.clear();
  primingThreads.clear();
}

function updateRunSummary(run, state) {
   if (!run) {
    runStatusBadge.textContent = "Idle";
    runStatusBadge.className = "run-badge";
    runStepLabel.textContent = "";
    runModelLabel.textContent = "";
    return;
   }

  const label = (run.status || "unknown").replace(/_/g, " ");  
  runStatusBadge.textContent = label;
  runStatusBadge.className = \`run-badge \${run.status}\`;

  const parts = [];
  if (typeof run.step === "number") parts.push(\`step \${run.step}\`);
  if (run.reason) parts.push(\`reason: \${run.reason}\`);
  runStepLabel.textContent = parts.join(" • ");

  const meta = [];
  const agentType = state?.agentType ?? state?.thread?.agentType;
  if (agentType) meta.push(\`Agent: \${agentType}\`);
  if (state?.model) meta.push(\`Model: \${state.model}\`);
  runModelLabel.textContent = meta.join(" • ");

}

function resetThreadView() {
  renderChat([]);
  updateRunSummary(null, null);
  renderTodos({});
  renderFiles({});
  S.textContent = "";
  extraThreads.clear();
  if (selectedThreadId && !latestThreads.some((t) => t.id === selectedThreadId)) {
    extraThreads.set(selectedThreadId, {
      id: selectedThreadId,
      createdAt: new Date().toISOString(),
      isSubagent: true,
      status: "active"
    });
  }
  if (subagentPanel) {
    subagentPanel.classList.remove("visible");
    if (subagentItems) subagentItems.innerHTML = "";
  }
  renderThreadList(latestThreads, selectedThreadId);
}

function closeAllSockets() {
  for (const lane of lanes.values()) {
    if (lane.ws && lane.ws.readyState === WebSocket.OPEN) {
      try {
        lane.ws.close(1000, "reset");
      } catch (err) {
        console.warn("Failed to close lane socket", err);
      }
    }
  }
  if (ws && ws.readyState === WebSocket.OPEN) {
    try {
      ws.close(1000, "reset");
    } catch (err) {
      console.warn("Failed to close main socket", err);
    }
  }
  mainThreadId = "";
  ws = undefined;
}

// Pan/drag handlers
G.addEventListener("mousedown", (e) => {
  panState.isPanning = true;
  panState.startX = e.clientX - panState.offsetX;
  panState.startY = e.clientY - panState.offsetY;
  G.style.cursor = "grabbing";
});

G.addEventListener("mousemove", (e) => {
  if (!panState.isPanning) return;
  panState.offsetX = (e.clientX - panState.startX);
  panState.offsetY = (e.clientY - panState.startY);
  applyTransform();
});

G.addEventListener("mouseup", () => {
  panState.isPanning = false;
  G.style.cursor = "grab";
});

G.addEventListener("mouseleave", () => {
  panState.isPanning = false;
  G.style.cursor = "grab";
});

G.addEventListener("wheel", (e) => {
  // Use pinch-zoom gesture (Ctrl/Cmd on most platforms).
  if (!e.ctrlKey && !e.metaKey) return;
  e.preventDefault();

  const factor = Math.pow(1.0015, -e.deltaY);  // smooth
  const newZoom = Math.max(minZoom, Math.min(maxZoom, zoom * factor));
  if (newZoom === zoom) return;

  zoom = newZoom;
  applyTransform();
}, { passive: false });

$("zoomIn").onclick   = () => { zoom = Math.min(maxZoom, zoom * 1.2); applyTransform(); };
$("zoomOut").onclick  = () => { zoom = Math.max(minZoom, zoom / 1.2); applyTransform(); };
$("zoomReset").onclick= () => { zoom = 1; panState.offsetX = 0; panState.offsetY = 0; applyTransform(); };

// Set initial cursor
G.style.cursor = "grab";

function applyTransform() {
  // translate, then scale (standard pattern used by D3)
  graphGroup.setAttribute("transform", \`translate(\${panState.offsetX}, \${panState.offsetY}) scale(\${zoom})\`);
  const zp = $("zoomPct"); if (zp) zp.textContent = Math.round(zoom * 100) + "%";
}

function laneFor(threadId) {
  if (lanes.has(threadId)) return lanes.get(threadId).lane;
  const lane = lanes.size;
  lanes.set(threadId, { lane, color: palette[lane % palette.length], nodes: [] });
  laneOrder.push(threadId);

  // draw lane label - positioned above the lane
  const y = margin.top + lane * margin.yStep;
  
  // Add background rect for better readability
  const rect = document.createElementNS("http://www.w3.org/2000/svg","rect");
  rect.setAttribute("x", 5);
  rect.setAttribute("y", y-40);
  rect.setAttribute("width", 85);
  rect.setAttribute("height", 16);
  rect.setAttribute("fill", "rgba(255, 255, 255, 0.05)");
  rect.setAttribute("rx", 4);
  graphGroup.appendChild(rect);
  
  const label = document.createElementNS("http://www.w3.org/2000/svg","text");
  label.setAttribute("x", 10);
  label.setAttribute("y", y-28);
  label.setAttribute("class", "laneLabel");
  label.textContent = lane === 0 ? \`Root Thread\` : \`Subagent #\${lane}\`;
  graphGroup.appendChild(label);

  resizeSVG();
  return lane;
}

function resizeSVG() {
  const width  = Math.max(900, G.clientWidth || 900); // keep viewport stable
  const height = Math.max(300, margin.top + Math.max(1, lanes.size) * margin.yStep);
  G.setAttribute("viewBox", \`0 0 \${width} \${height}\`);
  G.setAttribute("preserveAspectRatio", "xMinYMin meet");
}

function globalMaxIndex() {
  let m = 0;
  for (const tid of laneOrder) {
    const arr = lanes.get(tid).nodes;
    if (arr) m = Math.max(m, arr.length);
  }
  return m;
}

function addNode(threadId, type, label, payload) {
  const lane = laneFor(threadId);
  const laneObj = lanes.get(threadId);
  const idx = laneObj.nodes.length;

  const x = margin.left + idx * margin.xStep;
  const y = margin.top + lane * margin.yStep;

  // shape/color by type
  const colorMap = {
    tick: "#5aa7ff",
    model: "var(--model)",
    tool: "var(--tool)",
    done: "var(--ok)",
    paused: "var(--warn)",
    error: "var(--err)",
  };
  const fill = colorMap[type] || "#94a3b8";
  const radius = type === "tick" ? 10 : 18;

  const group = document.createElementNS("http://www.w3.org/2000/svg","g");

  // edge to previous
  const prevKey = lastNodePerLane.get(lane);
  if (prevKey) {
    const prev = nodeMap.get(prevKey);
    drawEdge(prev.x, prev.y, x, y, false);
  }

  // circle
  const c = document.createElementNS("http://www.w3.org/2000/svg","circle");
  c.setAttribute("cx", x); c.setAttribute("cy", y); c.setAttribute("r", radius);
  c.setAttribute("fill", fill); c.setAttribute("stroke", "#1e293b"); c.setAttribute("stroke-width", "1");
  c.setAttribute("opacity","0");
  c.setAttribute("class", "node-circle");
  c.setAttribute("vector-effect", "non-scaling-stroke");

  // Make node clickable
  c.style.cursor = "pointer";
  c.addEventListener("click", () => openModal(payload, label, type));

  // label
  const t = document.createElementNS("http://www.w3.org/2000/svg","text");
  t.setAttribute("x", x); t.setAttribute("y", y + (type==="tick"? -18 : 36));
  t.setAttribute("text-anchor","middle"); t.setAttribute("font-size","11"); t.setAttribute("fill","#334155");
  t.textContent = label;

  // tooltip
  const title = document.createElementNS("http://www.w3.org/2000/svg","title");
  title.textContent = "Click for details";
  c.appendChild(title);

  group.appendChild(c); group.appendChild(t);
  graphGroup.appendChild(group);

  const nodeKey = \`\${threadId}-\${payload.seq ?? Date.now()}-\${idx}\`;
  nodeMap.set(nodeKey, { x, y, type, elCircle:c, elText:t, threadId });
  lastNodePerLane.set(lane, nodeKey);
  laneObj.nodes.push(nodeKey);
  if (!firstNodeInLane.has(threadId)) firstNodeInLane.set(threadId, nodeKey);
  lastNodeInLane.set(threadId, nodeKey);

  // Animate in
  setTimeout(() => {
    c.style.transition = "opacity 0.3s ease-in-out";
    group.style.transition = "opacity 0.3s ease-in-out";
    c.style.opacity = "0.95";
    group.style.opacity = "1";
  }, 50);
  
  // Add pulse animation for important nodes
  if (["error", "paused"].includes(type)) {
    const animate = document.createElementNS("http://www.w3.org/2000/svg", "animate");
    animate.setAttribute("attributeName", "r");
    animate.setAttribute("values", \`\${radius};\${radius + 3};\${radius}\`);
    animate.setAttribute("dur", "2s");
    animate.setAttribute("repeatCount", "indefinite");
    c.appendChild(animate);
  }

  resizeSVG();
  return nodeKey;
}

function drawEdge(x1,y1,x2,y2,dashed) {
  const line = document.createElementNS("http://www.w3.org/2000/svg","line");
  line.setAttribute("x1", x1); line.setAttribute("y1", y1);
  line.setAttribute("x2", x2); line.setAttribute("y2", y2);
  line.setAttribute("stroke", "#64748b");
  line.setAttribute("stroke-width", "1.5");
  line.setAttribute("vector-effect", "non-scaling-stroke");
  if (dashed) line.setAttribute("stroke-dasharray","5,4");
  line.setAttribute("marker-end", \`url(#\${arrowId})\`);
  // insert edges behind nodes
  graphGroup.insertBefore(line, graphGroup.firstChild || null);
}

function connectLanes(fromNodeKey, toNodeKey) {
  const from = nodeMap.get(fromNodeKey);
  const to = nodeMap.get(toNodeKey);
  if (!from || !to) return;
  drawEdge(from.x, from.y, to.x, to.y, true);
}

function flushPendingEdgesForLane(threadId) {
  if (primingThreads.has(threadId)) return;
  const pend = pendingEdges.get(threadId);
  if (!pend || !pend.length) return;
  const lastKey = lastNodeInLane.get(threadId);
  if (!lastKey) return;
  for (const parentKey of pend) connectLanes(lastKey, parentKey);
  pendingEdges.delete(threadId);
}

function openModal(payload, label, type) {
  modalTitle.textContent = label + " - " + type;
  modalJson.textContent = JSON.stringify(payload, null, 2);
  modal.classList.add("open");
}

function closeModal() {
  modal.classList.remove("open");
}

function handleEvent(threadId, ev) {
  const t = ev?.type;
  if (!t) return;
  
  // Auto-refresh state on key events
  if (["agent.completed", "run.paused", "run.completed", "agent.error"].includes(t)) {
    refreshState();
  }

  // Map event to node
  switch (t) {
    case "run.tick": {
      addNode(threadId, "tick", \`tick #\${ev.data?.step ?? "?"}\`, ev);
      break;
    }
    case "model.started": {
      addNode(threadId, "model", \`model: \${ev.data?.model ?? ""}\`, ev);
      break;
    }
    // case "model.completed": {
    //   addNode(threadId, "model", "model ✓", ev);
    //   break;
    // }
    //case "tool.started": {
    //  const name = ev.data?.toolName ?? "tool";
    //  addNode(threadId, "tool", \`\${name} ▶\`, ev);
    // break;
    //}
    case "tool.output": {
      const name = ev.data?.toolName ?? "tool";
      addNode(threadId, "tool", \`\${name} ✓\`, ev);
      break;
    }
    case "tool.error": {
      const name = ev.data?.toolName ?? "tool";
      addNode(threadId, "error", \`\${name} ✗\`, ev);
      break;
    }
    case "run.paused": {
      const r = ev.data?.reason ?? "paused";
      addNode(threadId, "paused", \`paused (\${r})\`, ev);
      break;
    }
    case "run.resumed": {
      addNode(threadId, "tick", "resumed", ev);
      break;
    }
    case "agent.completed": {
      addNode(threadId, "done", "done ✓", ev);
      break;
    }
    case "agent.error": {
      addNode(threadId, "error", "error", ev);
      break;
    }
    case "subagent.spawned": {
      const child = ev.data?.childThreadId;
      const spawnKey = addNode(threadId, "tool", \`spawn \${short(child)}\`, ev);
      childSpawnMap.set(child, spawnKey);
      // auto-connect to child lane WS
      if (child) connectThreadWS(child);
      break;
    }
    case "subagent.completed": {
      const child = ev.data?.childThreadId;
      const doneKey = addNode(threadId, "tool", \`child \${short(child)} ✓\`, ev);
      // connect dashed from child's last to this node (if we have it)
      const childLast = lastNodeInLane.get(child);
      if (childLast && !primingThreads.has(child)) {
        connectLanes(childLast, doneKey);
      } else {
        const arr = pendingEdges.get(child) || [];
        arr.push(doneKey);
        pendingEdges.set(child, arr);
      }
      break;
    }
    default:
      // ignore or lightly mark important checkpoints
      if (t === "checkpoint.saved") {
        // tiny dot on current lane
        const lane = laneFor(threadId);
        const prevKey = lastNodePerLane.get(lane);
        const prev = prevKey && nodeMap.get(prevKey);
        if (prev) {
          const dot = document.createElementNS("http://www.w3.org/2000/svg","circle");
          dot.setAttribute("cx", prev.x + 10);
          dot.setAttribute("cy", prev.y - 14);
          dot.setAttribute("r", 3);
          dot.setAttribute("fill", "#64748b");
          graphGroup.appendChild(dot);
        }
      }
  }

  // If this is the first node in a child lane and we had a spawn in parent, connect dashed edge parent->child
  const firstKey = firstNodeInLane.get(threadId);
  if (firstKey && childSpawnMap.has(threadId)) {
    connectLanes(childSpawnMap.get(threadId), firstKey);
    childSpawnMap.delete(threadId);
  }

  flushPendingEdgesForLane(threadId);
}

function short(id) { return (id||"").slice(0,6); }

// --- Notification system ---
function showNotification(message, type = "info") {
  const notification = document.createElement("div");
  notification.className = \`notification \${type}\`;
  notification.textContent = message;
  
  document.body.appendChild(notification);
  
  setTimeout(() => {
    notification.style.opacity = "0";
    setTimeout(() => notification.remove(), 300);
  }, 3000);
}

// --- Connection status ---
function updateConnectionStatus(connected) {
  const status = connectionStatus;
  status.className = \`status-indicator \${connected ? "connected" : "disconnected"}\`;
  status.querySelector("span:last-child").textContent = connected ? "Connected" : "Disconnected";
}

// --- Existing UI functions (kept) ---
async function newThread() {
  try {
    const res = await fetch("/threads", { method: "POST" });
    const json = await res.json();
    const id = json.id;
    if (!id) throw new Error("Thread creation missing id");
    showNotification("New thread created", "success");
    await loadThreads(id);
    await selectThread(id);
  } catch (error) {
    console.error("Failed to create new thread:", error);
    showNotification("Failed to create new thread: " + error.message, "error");
  }
}

async function connect(idOverride) {
  const id = (idOverride ?? $("threadId").value ?? "").trim();
  if (!id) {
    showNotification("Please enter a thread ID", "error");
    return;
  }

  try {
    const switching = id !== mainThreadId;
    selectedThreadId = id;
    if (threadInput) threadInput.value = id;
    if (switching) {
      resetGraphState();
      resetThreadView();
    }
    mainThreadId = id;
    renderThreadList(latestThreads, id);
    await primeEventsDeep(id);
    showNotification("Connected to thread", "success");
    await refreshState();
    await loadThreads(id);
  } catch (error) {
    console.error("Connection error:", error);
    showNotification("Failed to connect: " + error.message, "error");
  }
}

async function primeEvents(threadId) {
  try {
    const r = await fetch(\`/threads/\${threadId}/events\`);
    const j = await r.json();
    const foundChildren = new Set();
    primingThreads.add(threadId);
    try {
      (j.events||[]).forEach(ev => {
        handleEvent(threadId, ev)
        if (ev?.type === "subagent.spawned" || ev?.type === "subagent.completed") {
          const cid = ev?.data?.childThreadId;
          if (cid) foundChildren.add(cid);
        }
      });
    } finally {
      primingThreads.delete(threadId);
      flushPendingEdgesForLane(threadId);
    }
    return [...foundChildren];
  } catch (e) { 
    console.error("Failed to prime events:", e);
    showNotification("Failed to load thread events", "error");
    return [];
  }
}

async function primeEventsDeep(rootId) {
  const visited = new Set();
  const q = [rootId];
  while (q.length) {
    const id = q.shift();
    if (visited.has(id)) continue;
    visited.add(id);

    // Prime this thread's past events first
    const children = await primeEvents(id);

    // Ensure we get live updates going forward
    connectThreadWS(id);

    // Prime each child, and let their own histories reveal grandchildren, etc.
    for (const c of children) {
      if (!visited.has(c)) q.push(c);
    }
  }
}

function connectThreadWS(threadId) {
  if (lanes.has(threadId) && lanes.get(threadId).ws) return; // already connected
  laneFor(threadId);
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const socket = new WebSocket(\`\${proto}://\${location.host}/threads/\${threadId}/ws\`);
  lanes.get(threadId).ws = socket;
  if (threadId === mainThreadId) ws = socket;

  socket.onopen = ()=>{
    console.log(\`[ws] \${threadId} connected\`);
    if (threadId === mainThreadId) updateConnectionStatus(true);
  };
  socket.onclose = ()=>{
    console.log(\`[ws] \${threadId} closed\`);
    if (threadId === mainThreadId) updateConnectionStatus(false);
  };
  socket.onmessage = (m)=>{
    try {
      const ev = JSON.parse(m.data);
      // Events from child sockets will have their own threadId
      const tid = ev.threadId || threadId;
      handleEvent(tid, ev);
    } catch (err) {
      console.error("WS message error:", err, m.data);
    }
  };
}

async function send() {
  const id = $("threadId").value.trim();
  const content = $("msg").value;
  if (!id || !content) {
    showNotification("Please enter a message", "error");
    return;
  }
  
  try {
    await fetch("/threads/" + id + "/invoke", {
      method:"POST",
      headers:{"content-type":"application/json"},
      body: JSON.stringify({ messages: [{ role:"user", content }] })
    });
    $("msg").value = "";
    showNotification("Message sent", "success");
    await refreshState();
  } catch (error) {
    console.error("Failed to send message:", error);
    showNotification("Failed to send message: " + error.message, "error");
  }
}

async function hitl(approved) {
  const id = $("threadId").value.trim();
  if (!id) {
    showNotification("No thread selected", "error");
    return;
  }
  
  try {
    await fetch("/threads/" + id + "/approve", {
      method:"POST",
      headers:{"content-type":"application/json"},
      body: JSON.stringify({ approved, modifiedToolCalls: [] })
    });
    showNotification((approved ? "Approved" : "Rejected") + " HITL request", "success");
    await refreshState();
  } catch (error) {
    console.error("Failed to send HITL response:", error);
    showNotification("Failed to send HITL response: " + error.message, "error");
  }
}

async function cancelRun() {
  const id = $("threadId").value.trim();
  if (!id) {
    showNotification("No thread selected", "error");
    return;
  }
  
  try {
    await fetch("/threads/" + id + "/cancel", { method:"POST" });
    showNotification("Run cancelled", "success");
    await refreshState();
  } catch (error) {
    console.error("Failed to cancel run:", error);
    showNotification("Failed to cancel run: " + error.message, "error");
  }
}

async function refreshState() {
  const id = $("threadId").value.trim();
  if (!id) return;
  try {
    const r = await fetch("/threads/" + id + "/state");
    const j = await r.json();
    S.textContent = JSON.stringify(j, null, 2);
    const state = j.state ?? {};
    renderChat(state.messages ?? []);
    renderTodos(state);
    renderFiles(state);
    updateRunSummary(j.run, state);
    renderSubagents(state.subagents ?? []);
  } catch (err) {
    console.error("Failed to refresh state:", err);
    showNotification("Failed to refresh state: " + err.message, "error");
  }
}

// Modal controls
modalClose.onclick = closeModal;
modal.onclick = (e) => { if (e.target === modal) closeModal(); };
document.addEventListener("keydown", (e) => { 
  if (e.key === "Escape") closeModal(); 
  // Ctrl/Cmd + Enter to send message
  if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
    e.preventDefault();
    send();
  }
  // Ctrl/Cmd + N for new thread
  if ((e.ctrlKey || e.metaKey) && e.key === "n") {
    e.preventDefault();
    newThread();
  }
});

// Button handlers
 $("btnNew").onclick = () => newThread();
 if (btnRefreshThreads) btnRefreshThreads.onclick = () => loadThreads();
 $("btnSend").onclick = send;
 $("btnApprove").onclick = () => hitl(true);
 $("btnReject").onclick = () => hitl(false);
 $("btnCancel").onclick = cancelRun;
 $("btnState").onclick = refreshState;
 if (threadInput) {
   threadInput.addEventListener("keydown", (event) => {
     if (event.key === "Enter") {
       event.preventDefault();
       const value = threadInput.value.trim();
       if (value) selectThread(value);
     }
   });
 }

// Initial load
resetThreadView();
loadThreads();

// Thread & chat helpers
function formatRelativeTime(iso) {
  if (!iso) return "";
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return iso;
  const diff = Date.now() - ts;
  const abs = Math.abs(diff);
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (abs < minute) return "just now";
  if (abs < hour) return \`\${Math.round(abs / minute)}m ago\`;
  if (abs < day) return \`\${Math.round(abs / hour)}h ago\`;
  return new Date(ts).toLocaleString();
}


async function selectThread(id, { connectThread = true } = {}) {
  if (!id) return;
  selectedThreadId = id;
  if (threadInput) threadInput.value = id;
  renderThreadList(latestThreads, id);
  if (connectThread) {
    await connect(id);
  } else {
    await refreshState();
  }
}

function renderSubagents(subagents = []) {
  extraThreads.clear();
  if (!subagentPanel || !subagentItems) return;

  if (!Array.isArray(subagents) || subagents.length === 0) {
    if (selectedThreadId && !latestThreads.some((t) => t.id === selectedThreadId)) {
      extraThreads.set(selectedThreadId, {
        id: selectedThreadId,
        createdAt: new Date().toISOString(),
        isSubagent: true,
        status: "active"
      });
    }
    subagentPanel.classList.remove("visible");
    subagentItems.innerHTML = "";
    renderThreadList(latestThreads, selectedThreadId);
    return;
  }

  subagentPanel.classList.add("visible");
  subagentItems.innerHTML = "";

  for (const link of subagents) {
    if (!link?.childThreadId) continue;
    const childId = link.childThreadId;
    const createdAtIso = new Date(link.createdAt ?? Date.now()).toISOString();
    extraThreads.set(childId, {
      id: childId,
      createdAt: createdAtIso,
      status: link.status,
      parent: { threadId: selectedThreadId },
      report: link.report,
      isSubagent: true
    });

    const item = document.createElement("div");
    item.className = "subagent-item" + (childId === selectedThreadId ? " active" : "");

    const title = document.createElement("div");
    title.className = "subagent-title";
    title.textContent = childId;
    item.appendChild(title);

    const statusRow = document.createElement("div");
    statusRow.className = "subagent-status";
    const statusLabel = (link.status ?? "unknown").replace(/_/g, " ");
    const statusParts = [\`Status: \${statusLabel}\`];
    if (link.completedAt) statusParts.push("Completed");
    statusParts.push(formatRelativeTime(createdAtIso));
    statusRow.textContent = statusParts.join(" • ");
    item.appendChild(statusRow);

    if (link.report) {
      const report = document.createElement("div");
      report.className = "subagent-report";
      report.textContent = link.report;
      item.appendChild(report);
    }

    const actions = document.createElement("div");
    actions.className = "subagent-actions";
    const openBtn = document.createElement("button");
    openBtn.textContent = "Open";
    openBtn.onclick = () => selectThread(childId);
    actions.appendChild(openBtn);
    item.appendChild(actions);

    subagentItems.appendChild(item);
  }

  renderThreadList(latestThreads, selectedThreadId);
}

function renderChat(messages = []) {
  chatTranscript.innerHTML = "";
  if (!messages.length) {
    const empty = document.createElement("div");
    empty.className = "chat-empty";
    empty.textContent = "No messages yet. Send a user prompt to get started.";
    chatTranscript.appendChild(empty);
    return;
  }

  for (const msg of messages) {
    const role = msg.role;
    const bubble = document.createElement("div");
    bubble.className = "chat-message " + role;

    const roleLabel = document.createElement("div");
    roleLabel.className = "chat-role";
    roleLabel.textContent = role.toUpperCase();
    bubble.appendChild(roleLabel);

    const content = document.createElement("div");
    content.className = "chat-content";

    if (role === "assistant" && msg.toolCalls?.length) {
      if (msg.content) {
        const text = document.createElement("div");
        text.textContent = msg.content;
        content.appendChild(text);
      }
      for (const call of msg.toolCalls) {
        const toolWrap = document.createElement("div");
        toolWrap.className = "tool-call";
        const title = document.createElement("div");
        title.style.fontWeight = "600";
        title.textContent = call.name || "tool";
        const pre = document.createElement("pre");
        pre.textContent = JSON.stringify(call.args ?? {}, null, 2);
        toolWrap.appendChild(title);
        toolWrap.appendChild(pre);
        content.appendChild(toolWrap);
      }
    } else if (role === "tool") {
      const pre = document.createElement("pre");
      pre.textContent = msg.content ?? "";
      content.appendChild(pre);
    } else {
      content.textContent = msg.content ?? "";
    }

    bubble.appendChild(content);
    chatTranscript.appendChild(bubble);
  }

  chatTranscript.scrollTop = chatTranscript.scrollHeight;
}

async function loadThreads(activeId) {
  try {
    const res = await fetch("/threads");
    const data = await res.json();
    const threads = (data.threads ?? []).slice();
    threads.sort((a, b) => {
      const ta = Date.parse(a.createdAt ?? "");
      const tb = Date.parse(b.createdAt ?? "");
      if (Number.isNaN(ta) || Number.isNaN(tb)) return 0;
      return tb - ta;
    });
    latestThreads = threads;
    renderThreadList(latestThreads, activeId ?? selectedThreadId);
  } catch (error) {
    console.error("Failed to load threads:", error);
    showNotification("Failed to load threads", "error");
  }
}

function renderThreadList(threads = [], activeId) {
  const combined = new Map();

  for (const meta of threads ?? []) {
    if (!meta?.id) continue;
    combined.set(meta.id, { ...meta, source: "root" });
  }

  for (const meta of extraThreads.values()) {
    if (!meta?.id) continue;
    if (!combined.has(meta.id)) combined.set(meta.id, meta);
  }

  const list = Array.from(combined.values());
  list.sort((a, b) => {
    const ta = Date.parse(a.createdAt ?? "");
    const tb = Date.parse(b.createdAt ?? "");
    if (Number.isNaN(ta) && Number.isNaN(tb)) return 0;
    if (Number.isNaN(ta)) return 1;
    if (Number.isNaN(tb)) return -1;
    return tb - ta;
  });

  threadsListEl.innerHTML = "";
  if (!list.length) {
    threadsListEl.innerHTML =
      '<div class="threads-empty">No threads yet. Create one to get started.</div>';
    return;
  }

  for (const meta of list) {
    const btn = document.createElement("button");
    btn.type = "button";
    const isActive = meta.id === activeId;
    btn.className = "thread-item" + (isActive ? " active" : "");
    const metaBits = [];
    if (meta.createdAt) metaBits.push(formatRelativeTime(meta.createdAt));
    if (meta.isSubagent) metaBits.push("Subagent");
    if (meta.agentType) metaBits.push(\`Agent: \${meta.agentType}\`);
    if (meta.status) metaBits.push(\`Status: \${meta.status}\`);
    if (meta.parent?.threadId) metaBits.push(\`Child of \${short(meta.parent.threadId)}\`);
    const city = meta.request?.cf?.city;
    if (city) metaBits.push(city);

    btn.innerHTML = \`
      <div class="thread-title">\${escapeHtml(meta.id)}</div>
      <div class="thread-meta">\${metaBits.map((part) => escapeHtml(String(part))).join(" • ")}</div>
    \`;
    const tooltip = [];
    if (meta.request?.userAgent) tooltip.push(meta.request.userAgent);
    if (meta.report) tooltip.push(\`Report: \${meta.report}\`);
    if (tooltip.length) btn.title = tooltip.join("\\n\\n");
    btn.onclick = () => selectThread(meta.id);
    threadsListEl.appendChild(btn);
  }
}


// ---- Todos ----

function renderTodos(state) {
  const todos = state?.todos || [];
  const wrap = document.getElementById("todosList");
  const summary = document.getElementById("todosSummary");
  wrap.innerHTML = "";
  summary.innerHTML = "";

  if (!todos.length) {
    summary.innerHTML = \`<span class="todo-pill">No todos yet</span>\`;
    return;
  }

  const counts = { pending:0, in_progress:0, completed:0 };
  todos.forEach(t => { counts[t.status] = (counts[t.status]||0)+1; });

  summary.innerHTML = \`
    <span class="todo-pill pending">Pending: \${counts.pending||0}</span>
    <span class="todo-pill in_progress">In progress: \${counts.in_progress||0}</span>
    <span class="todo-pill completed">Completed: \${counts.completed||0}</span>
    <span class="todo-pill">Total: \${todos.length}</span>
  \`;

  for (const t of todos) {
    const li = document.createElement("li");
    li.className = "todo-item";
    li.innerHTML = \`
      <span class="todo-status \${t.status}"></span>
      <div class="todo-content">
        <div>\${escapeHtml(t.content||"")}</div>
        <div style="margin-top:6px; font-size:12px; color:var(--muted);">Status: \${t.status}</div>
      </div>
    \`;
    wrap.appendChild(li);
  }
}

// ---- Files ----
let _selectedFile = null;

function renderFiles(state) {
  const files = state?.files || {};
  const list = document.getElementById("filesList");
  const preview = document.getElementById("filePreview");
  list.innerHTML = "";
  preview.textContent = "";

  const paths = Object.keys(files).sort();
  if (!paths.length) {
    list.innerHTML = \`<div class="file-row"><span class="file-name">(no files)</span></div>\`;
    return;
  }

  for (const p of paths) {
    const content = files[p] ?? "";
    const size = new TextEncoder().encode(content).length; // bytes
    const lines = content ? content.split(/\\r?\\n/).length : 0;

    const row = document.createElement("div");
    row.className = "file-row";
    row.onclick = () => selectFile(p, content);
    row.innerHTML = \`
      <span class="file-name" title="\${escapeHtml(p)}">\${escapeHtml(p)}</span>
      <span class="file-meta">\${lines} lines • \${size} B</span>
    \`;
    list.appendChild(row);
  }

  // keep previous selection if still present
  if (_selectedFile && files[_selectedFile] !== undefined) {
    selectFile(_selectedFile, files[_selectedFile]);
  } else {
    // auto-select first
    const first = paths[0];
    selectFile(first, files[first]);
  }
}

function selectFile(path, content) {
  _selectedFile = path;
  const code = document.getElementById("filePreview");
  code.innerHTML = renderWithLineNumbers(content || "");
}

// helpers
function renderWithLineNumbers(text) {
  const lines = (text ?? "").split(/\\r?\\n/);
  return lines.map((line, i) => {
    const ln = String(i+1).padStart(4, " ");
    return \`<span class="ln">\${ln}</span>\${escapeHtml(line)}\n\`;
  }).join("");
}

function escapeHtml(s) {
  return String(s)
    .replaceAll("&","&amp;")
    .replaceAll("<","&lt;")
    .replaceAll(">","&gt;")
    .replaceAll("\\"","&quot;")
    .replaceAll("'","&#039;");
}
</script>
</body>
</html>`;
