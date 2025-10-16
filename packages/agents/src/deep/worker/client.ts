export const html = `<!doctype html>
<html>
<meta charset="utf-8"/>
<title>Agent Dashboard</title>
<style>
  :root {
    --bg: #050608;
    --surface: rgba(10, 14, 22, 0.92);
    --surface-alt: rgba(13, 18, 29, 0.85);
    --fg: #f5f7fa;
    --muted: #9da5ba;
    --accent: #f97316;
    --accent-soft: rgba(249, 115, 22, 0.14);
    --border: rgba(255, 255, 255, 0.1);
    --border-strong: rgba(249, 115, 22, 0.4);
    --ok: #22c55e;
    --warn: #facc15;
    --err: #ef4444;
    --info: #60a5fa;
    --tool: #c084fc;
    --model: #34d399;
    --pause: #fb923c;
  }
  
  body { 
    font: 14px "Inter", system-ui, sans-serif; 
    margin: 0; 
    padding: 0;
    color: var(--fg);
    background-color: #0b101c;
    background-image:
      radial-gradient(rgba(255, 255, 255, 0.04) 1px, transparent 0),
      radial-gradient(rgba(255, 255, 255, 0.025) 1px, transparent 0);
    background-size: 28px 28px, 12px 12px;
    background-position: 0 0, 14px 14px;
    min-height: 100vh;
  }
  
  ::selection {
    background: var(--accent);
    color: #0b0e1a;
  }
  
  .container {
    box-sizing: border-box;
    width: 100%;
    max-width: none;
    margin: 0;
    padding: 28px 36px 60px;
  }

  .dashboard {
    display: grid;
    grid-template-columns: 260px minmax(0, 1fr);
    gap: 24px;
    align-items: flex-start;
  }

  .sidebar {
    display: flex;
    flex-direction: column;
    min-height: calc(100vh - 180px);
    gap: 16px;
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
    letter-spacing: 0.02em;
  }

  .sidebar-header p {
    margin: 6px 0 0;
    color: var(--muted);
    font-size: 12px;
  }

  .sidebar-actions {
    display: flex;
    gap: 8px;
    align-items: center;
  }

  .threads-list {
    flex: 1;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding-right: 4px;
  }

  .thread-item {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 6px;
    padding: 12px 14px;
    border-radius: 8px;
    border: 1px dashed transparent;
    background: rgba(255, 255, 255, 0.02);
    color: var(--fg);
    text-align: left;
    cursor: pointer;
    transition: background 0.2s ease, border 0.2s ease, transform 0.2s;
  }

  .thread-item:hover {
    background: rgba(249, 115, 22, 0.08);
    border-color: var(--border);
    transform: translateX(2px);
  }

  .thread-item.active {
    border-color: var(--accent);
    background: rgba(249, 115, 22, 0.16);
  }

  .thread-title {
    font-size: 14px;
    font-weight: 600;
    word-break: break-all;
  }

  .thread-meta {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
    color: var(--muted);
    font-size: 12px;
  }

  .threads-empty {
    text-align: center;
    padding: 24px 14px;
    border-radius: 8px;
    border: 1px dashed var(--border);
    background: rgba(255, 255, 255, 0.02);
    color: var(--muted);
    font-size: 13px;
  }

  .main-content {
    display: grid;
    grid-template-columns: minmax(0, 3.5fr) minmax(320px, 1.4fr);
    grid-template-areas:
      "chat side"
      "thread side"
      "state side";
    gap: 28px;
    align-items: flex-start;
  }

  .main-column {
    display: flex;
    flex-direction: column;
    gap: 20px;
  }

  .chat-card {
    grid-area: chat;
    display: flex;
    flex-direction: column;
    gap: 20px;
    min-height: 580px;
    max-height: 1000px
  }

  .chat-header {
    display: flex;
    flex-wrap: wrap;
    gap: 16px;
    align-items: flex-end;
  }

  .chat-header .input-group {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .chat-header label {
    font-size: 13px;
    color: var(--muted);
    letter-spacing: 0.04em;
  }

  .run-summary {
    margin-top: 16px;
    display: flex;
    flex-wrap: wrap;
    gap: 12px;
    align-items: center;
  }

  .run-badge {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 4px 12px;
    border-radius: 999px;
    border: 1px dashed var(--border);
    background: rgba(255, 255, 255, 0.04);
    font-size: 12px;
    font-weight: 600;
    text-transform: capitalize;
  }

  .run-badge.running {
    color: var(--accent);
    border-color: var(--border-strong);
    background: var(--accent-soft);
  }

  .run-badge.paused {
    color: var(--pause);
    border-color: rgba(251, 146, 60, 0.35);
    background: rgba(251, 146, 60, 0.15);
  }

  .run-badge.completed {
    color: var(--ok);
    border-color: rgba(34, 197, 94, 0.35);
    background: rgba(34, 197, 94, 0.18);
  }

  .run-badge.error {
    color: var(--err);
    border-color: rgba(239, 68, 68, 0.4);
    background: rgba(239, 68, 68, 0.18);
  }

  .run-meta {
    font-size: 13px;
    color: var(--muted);
  }


  .chat-transcript {
    background: var(--surface-alt);
    border: 1px dashed var(--border);
    border-radius: 6px;
    padding: 18px;
    margin-top: 16px;
    min-height: 360px;
    max-height: none;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 14px;
  }

  .chat-empty {
    text-align: center;
    color: var(--muted);
    padding: 48px 0;
  }

  .chat-message {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 14px 16px;
    border-radius: 8px;
    border: 1px dashed rgba(255, 255, 255, 0.08);
    max-width: 70%;
    background: rgba(255, 255, 255, 0.02);
  }

  .chat-message.user {
    align-self: flex-end;
    background: rgba(249, 115, 22, 0.2);
    border-color: rgba(249, 115, 22, 0.5);
    color: #fff7ed;
  }

  .chat-message.assistant {
    align-self: flex-start;
    background: rgba(34, 197, 94, 0.18);
    border-color: rgba(34, 197, 94, 0.45);
  }

  .chat-message.tool {
    align-self: flex-start;
    background: rgba(192, 132, 252, 0.16);
    border-color: rgba(192, 132, 252, 0.45);
  }

  .chat-role {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    color: var(--muted);
  }

  .chat-content {
    font-size: 14px;
    line-height: 1.6;
    white-space: pre-wrap;
    word-break: break-word;
  }

  .tool-call {
    margin-top: 10px;
    border: 1px dashed rgba(255, 255, 255, 0.18);
    border-radius: 6px;
    background: rgba(6, 10, 18, 0.92);
    font-family: "JetBrains Mono", Consolas, monospace;
    font-size: 12px;
    overflow: hidden;
  }

  .tool-call.collapsed .tool-call-body {
    display: none;
  }

  .tool-call-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 10px 12px;
  }

  .tool-call-title {
    font-weight: 600;
    color: var(--fg);
  }

  .tool-call-toggle {
    border: 1px dashed rgba(255, 255, 255, 0.12);
    background: rgba(255, 255, 255, 0.06);
    color: var(--muted);
    font-family: inherit;
    font-size: 12px;
    padding: 4px 8px;
    border-radius: 4px;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }

  .tool-call-toggle:hover {
    background: rgba(249, 115, 22, 0.16);
    color: var(--fg);
  }

  .tool-call-body {
    padding: 0 12px 12px;
    max-height: 420px;
    overflow: auto;
  }

  .chat-input {
    margin-top: 16px;
    display: flex;
    gap: 12px;
    align-items: center;
  }

  .chat-input textarea {
    flex: 1;
    min-height: 80px;
  }

  .chat-actions {
    margin-top: 12px;
    display: flex;
    justify-content: flex-end;
  }

  .shortcuts-hint {
    font-size: 12px;
    color: var(--muted);
  }

  .shortcut {
    display: inline-block;
    padding: 2px 6px;
    background: rgba(255, 255, 255, 0.08);
    border-radius: 4px;
    font-family: monospace;
    margin: 0 2px;
  }

  .header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 24px;
    padding-bottom: 16px;
    border-bottom: 1px dashed var(--border);
  }
  
  .header h1 {
    margin: 0;
    font-size: 26px;
    font-weight: 600;
    letter-spacing: 0.04em;
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
    gap: 8px;
    padding: 6px 12px;
    border-radius: 999px;
    font-size: 12px;
    font-weight: 600;
    border: 1px dashed var(--border);
    background: rgba(255, 255, 255, 0.03);
  }
  
  .status-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
  }
  
  .status-indicator.connected { 
    color: var(--ok);
    border-color: rgba(34, 197, 94, 0.4);
  }
  .status-indicator.connected .status-dot { 
    background-color: var(--ok);
  }
  .status-indicator.disconnected { 
    color: var(--err);
    border-color: rgba(239, 68, 68, 0.4);
  }
  .status-indicator.disconnected .status-dot { 
    background-color: var(--err);
  }
  
  .card {
    background: var(--surface);
    border-radius: 8px;
    padding: 20px;
    margin-bottom: 16px;
    backdrop-filter: blur(12px);
    box-shadow: 0 10px 30px rgba(0, 0, 0, 0.35);
    border: 1px dashed var(--border);
  }
  
  textarea, input { 
    box-sizing: border-box;
    width: 100%; 
    padding: 10px 12px;
    border-radius: 6px;
    border: 1px dashed rgba(255, 255, 255, 0.12);
    background: rgba(6, 10, 18, 0.9);
    color: var(--fg);
    font-family: inherit;
  }
  
  textarea:focus, input:focus {
    outline: none;
    border-color: var(--accent);
    box-shadow: 0 0 0 2px rgba(249, 115, 22, 0.25);
  }
  
  pre { 
    background: rgba(6, 10, 18, 0.9); 
    color: var(--fg); 
    padding: 16px; 
    border-radius: 6px; 
    max-height: 500px; 
    overflow: auto; 
    word-wrap: break-word; 
    white-space: pre-wrap;
    border: 1px dashed var(--border);
    font-family: "JetBrains Mono", Consolas, monospace;
    font-size: 12px;
  }
  
  button { 
    padding: 8px 12px; 
    border-radius: 6px; 
    border: 1px dashed var(--border); 
    background: rgba(255, 255, 255, 0.04);
    color: var(--fg);
    cursor: pointer;
    transition: background 0.2s ease, transform 0.2s ease, border-color 0.2s ease;
  }
  
  button:hover {
    background: rgba(255, 255, 255, 0.1);
    transform: translateY(-1px);
  }
  
  button:active {
    transform: translateY(0);
  }
  
  button.primary {
    background: var(--accent);
    color: #050608;
    border-color: var(--border-strong);
  }
  
  button.primary:hover {
    background: #fb8f3c;
  }
  
  button.danger {
    background: rgba(239, 68, 68, 0.15);
    color: #fecaca;
    border-color: rgba(239, 68, 68, 0.45);
  }
  
  button.danger:hover {
    background: rgba(239, 68, 68, 0.3);
  }
  
  .button-group {
    display: flex;
    gap: 10px;
    flex-wrap: wrap;
  }
  
  code { 
    white-space: pre-wrap; 
    font-family: "JetBrains Mono", Consolas, monospace;
  }

  /* Graph area */
  .threadline-card {
    grid-area: thread;
    display: flex;
    flex-direction: column;
    gap: 16px;
  }

  .threadline-header {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
    align-items: center;
    color: var(--muted);
    font-size: 12px;
  }

  .threadline-header .badge {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 4px 10px;
    border-radius: 999px;
    border: 1px dashed var(--border);
    background: rgba(255, 255, 255, 0.03);
  }

  .threadline-badge-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    display: inline-block;
  }

  .graph-wrap { 
    position: relative;
    border: 1px dashed var(--border); 
    border-radius: 6px; 
    padding: 0;
    background:
      radial-gradient(rgba(255, 255, 255, 0.04) 1px, transparent 0),
      linear-gradient(160deg, rgba(10, 14, 22, 0.85), rgba(13, 18, 29, 0.9));
    background-size: 20px 20px, 100% 100%;
    overflow:hidden; 
    height: 620px;
  }

  #graph { 
    display:block; 
    width: 100%;
    height: 100%;
    user-select: none;
    -webkit-user-select: none;
  }

  .laneLabel { 
    font: 11px "Inter", system-ui, sans-serif; 
    fill:var(--muted); 
    font-weight:600; 
    letter-spacing: 0.06em;
  }

  .node-circle { 
    cursor:pointer; 
    transition:opacity 0.2s; 
  }

  .node-circle:hover { 
    opacity:1 !important; 
  }

  .lane-label-card {
    fill: rgba(8, 12, 20, 0.88);
    stroke: rgba(255, 255, 255, 0.14);
    stroke-dasharray: 4 4;
  }

  .lane-label-title {
    font: 12px "Inter", system-ui, sans-serif;
    fill: var(--fg);
    font-weight: 600;
  }

  .lane-label-meta {
    font: 11px "Inter", system-ui, sans-serif;
    fill: var(--muted);
    letter-spacing: 0.04em;
  }

  /* Modal */
  .modal { 
    display:none; 
    position:fixed; 
    inset:0; 
    background:rgba(0,0,0,0.78); 
    z-index:1000; 
    align-items:center; 
    justify-content:center; 
  }
  .modal.open { 
    display:flex; 
  }
  .modal-content { 
    background: linear-gradient(135deg, rgba(18,26,42,0.95) 0%, rgba(6,10,18,0.98) 100%);
    color: var(--fg); 
    padding:24px; 
    border-radius:8px; 
    max-width:760px; 
    max-height:80vh; 
    overflow:auto; 
    position:relative; 
    box-shadow:0 20px 60px rgba(0,0,0,0.6);
    border: 1px dashed var(--border);
  }
  .modal-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 16px;
    padding-bottom: 12px;
    border-bottom: 1px dashed var(--border);
  }
  .modal-title { 
    margin:0; 
    font-size:18px; 
    color:var(--accent); 
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
    background:rgba(6,10,18,0.92); 
    padding:16px; 
    border-radius:6px; 
    overflow:auto; 
    max-height:520px; 
    font:12px "JetBrains Mono", monospace; 
    white-space:pre-wrap; 
    word-wrap:break-word; 
    overflow-wrap:break-word;
    border: 1px dashed var(--border);
  }
  

  .zoom-controls {
    position: absolute;
    bottom: 14px;
    right: 14px;
    display: flex;
    gap: 8px;
    align-items: center;
    background: rgba(10, 14, 22, 0.82);
    border: 1px dashed var(--border);
    padding: 6px 8px;
    border-radius: 6px;
    backdrop-filter: blur(8px);
  }
  .zoom-controls button {
    padding: 4px 10px;
  }
  .zoom-controls .zoom-pct {
    min-width: 52px;
    text-align: center;
    font-weight: 600;
    color: var(--muted);
  }

  .side-panel {
    grid-area: side;
    display: flex;
    flex-direction: column;
    gap: 20px;
    min-width: 0;
  }

  .panel-tabs {
    display: flex;
    gap: 8px;
  }

  .panel-tab {
    flex: 1;
    padding: 10px 12px;
    border-radius: 6px;
    border: 1px dashed transparent;
    background: rgba(255, 255, 255, 0.04);
    color: var(--muted);
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.08em;
  }

  .panel-tab.active {
    color: var(--fg);
    border-color: var(--border-strong);
    background: rgba(249, 115, 22, 0.14);
  }

  .panel-section {
    display: none;
    flex-direction: column;
    gap: 16px;
  }

  .panel-section.active {
    display: flex;
  }

  .todos-summary {
    display:flex; 
    gap:10px; 
    flex-wrap:wrap; 
    margin: 8px 0 12px;
    color: var(--muted); 
    font-size: 12px;
  }
  .todo-pill {
    display:inline-flex; align-items:center; gap:6px;
    padding:4px 8px; border-radius:999px; border:1px dashed var(--border);
    background: rgba(255,255,255,0.03); font-weight: 600;
  }
  .todo-pill.pending { color:#a5b1c2; }
  .todo-pill.in_progress { color: var(--info); }
  .todo-pill.completed { color: var(--ok); }

  .todo-list { list-style:none; padding:0; margin:0; display:flex; flex-direction:column; gap:10px; }
  .todo-item {
    display:flex; align-items:flex-start; gap:12px;
    padding:10px 12px; border:1px dashed var(--border);
    border-radius:6px; background: rgba(255,255,255,0.02);
  }
  .todo-status {
    min-width: 8px; min-height:8px; border-radius:999px; margin-top:6px;
  }
  .todo-status.pending { background:#9ca3af; }
  .todo-status.in_progress { background: var(--info); }
  .todo-status.completed { background: var(--ok); }
  .todo-content { word-break:break-word; font-size: 13px; }

  .files-panel {
    display:flex; flex-direction:column; gap:12px;
  }
  .files-list {
    border:1px dashed var(--border); border-radius:6px;
    background: rgba(255,255,255,0.02); overflow:auto; max-height:420px;
  }
  .file-row {
    display:flex; align-items:center; justify-content:space-between;
    padding:10px 12px; cursor:pointer; border-bottom:1px dashed rgba(255,255,255,0.06);
  }
  .file-row:last-child { border-bottom: none; }
  .file-row:hover { background: rgba(249,115,22,0.08); }
  .file-name {
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
    font-size:12px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width: 180px;
  }
  .file-meta { font-size:12px; color: var(--muted); }
  .file-preview {
    background:rgba(6,10,18,0.9); padding:12px; border:1px dashed var(--border);
    border-radius:6px; max-height:420px; overflow:auto;
  }

  /* line numbers in preview */
  .ln { color:#5f6a87; user-select:none; margin-right:10px; display:inline-block; width:48px; text-align:right; }
  .code { white-space:pre; font-size: 12px; }

  .state-card {
    grid-area: state;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .notification {
    position: fixed;
    bottom: 24px;
    right: 24px;
    padding: 12px 16px;
    border-radius: 6px;
    color: white;
    font-weight: 600;
    box-shadow: 0 12px 34px rgba(0, 0, 0, 0.3);
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

  @media (max-width: 1280px) {
    .dashboard {
      grid-template-columns: 1fr;
    }

    .sidebar {
      min-height: auto;
    }
  }

  @media (max-width: 1024px) {
    .main-content {
      grid-template-columns: 1fr;
      grid-template-areas:
        "chat"
        "side"
        "thread"
        "state";
    }

    .side-panel {
      order: 2;
    }

    .threadline-card {
      order: 3;
    }
  }

  @media (max-width: 768px) {
    .container {
      padding: 20px 16px 40px;
    }

    .chat-card {
      min-height: 420px;
    }

    .graph-wrap {
      height: 420px;
    }

    .modal-content {
      max-width: 90%;
      padding: 18px;
    }
  }
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

      <div class="main-content">
        <section class="card chat-card">
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
        </section>

        <section class="card threadline-card">
          <div class="threadline-header">
            <span class="badge"><span class="threadline-badge-dot" style="background:var(--model)"></span>Model</span>
            <span class="badge"><span class="threadline-badge-dot" style="background:var(--tool)"></span>Tool</span>
            <span class="badge"><span class="threadline-badge-dot" style="background:var(--ok)"></span>Completed</span>
            <span class="badge"><span class="threadline-badge-dot" style="background:var(--warn)"></span>Paused</span>
            <span class="badge"><span class="threadline-badge-dot" style="background:var(--err)"></span>Error</span>
            <span class="badge"><span class="threadline-badge-dot" style="background:var(--info)"></span>Run Tick</span>
            <span class="badge">Dashed path = linked agent</span>
            <span class="badge" style="margin-left:auto;">💡 Drag to pan • Ctrl/Cmd + scroll to zoom</span>
          </div>
          <div class="graph-wrap">
            <svg id="graph"></svg>
            <div class="zoom-controls">
              <button id="zoomOut">-</button>
              <span class="zoom-pct" id="zoomPct">100%</span>
              <button id="zoomIn">+</button>
              <button id="zoomReset">Reset</button>
            </div>
          </div>
        </section>

        <aside class="card side-panel">
          <div class="panel-tabs">
            <button class="panel-tab active" data-panel-target="todosPanel">Todos</button>
            <button class="panel-tab" data-panel-target="filesPanel">Files</button>
          </div>
          <div id="todosPanel" class="panel-section active">
            <div class="todos-summary" id="todosSummary"></div>
            <ul class="todo-list" id="todosList"></ul>
          </div>
          <div id="filesPanel" class="panel-section">
            <div class="files-panel">
              <div class="files-list" id="filesList"></div>
              <pre class="file-preview"><code id="filePreview" class="code"></code></pre>
            </div>
          </div>
        </aside>

        <section class="card state-card">
          <h3>State</h3>
          <pre id="state"></pre>
        </section>
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
const btnRefreshThreads = $("btnRefreshThreads");
const panelTabs = Array.from(document.querySelectorAll(".panel-tab"));
const panelSections = new Map(
  Array.from(document.querySelectorAll(".panel-section")).map((section) => [section.id, section])
);

for (const btn of panelTabs) {
  btn.addEventListener("click", () => {
    const target = btn.getAttribute("data-panel-target");
    if (!target || !panelSections.has(target)) return;
    for (const other of panelTabs) {
      other.classList.toggle("active", other === btn);
    }
    for (const [id, section] of panelSections) {
      section.classList.toggle("active", id === target);
    }
  });
}

let mainThreadId = "";
let ws; // main ws
let selectedThreadId = "";
let latestThreads = [];
const extraThreads = new Map();

// --- Graph state ---
const palette = ["#2563eb","#16a34a","#9333ea","#ea580c","#0891b2","#b91c1c","#0ea5e9","#059669"];
const lanes = new Map(); // threadId -> { lane, color, ws?, nodes:[], lastNodeKey?:string, label?:{...} }
const laneMeta = new Map(); // threadId -> meta info
const laneOrder = []; // threadIds in display order
const nodeMap = new Map(); // nodeKey -> {x,y,type,elCircle,elText,threadId}
const lastNodePerLane = new Map(); // lane -> nodeKey
const childSpawnMap = new Map(); // childId -> spawnNodeKey (in parent)
const firstNodeInLane = new Map(); // threadId -> first nodeKey
const lastNodeInLane = new Map(); // threadId -> last nodeKey
const margin = {left:220, top:40, xStep:140, yStep:110};
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
  path.setAttribute("d","M 0 0 L 10 5 L 0 10 z"); path.setAttribute("fill","rgba(148, 163, 184, 0.7)");
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
  laneMeta.clear();
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

  const threadId = selectedThreadId || mainThreadId || state?.thread?.id;
  updateLaneMeta(threadId, {
    title: agentType || (threadId === mainThreadId ? "Root Agent" : undefined),
    agentType,
    status: run.status,
    model: state?.model,
    createdAt: state?.thread?.createdAt
  });

}

function resetThreadView() {
  renderChat([]);
  updateRunSummary(null, null);
  renderTodos({});
  renderFiles({});
  S.textContent = "";
  extraThreads.clear();
  if (selectedThreadId && !latestThreads.some((t) => t.id === selectedThreadId)) {
    const created = new Date().toISOString();
    extraThreads.set(selectedThreadId, {
      id: selectedThreadId,
      createdAt: created,
      isSubagent: true,
      status: "active"
    });
    updateLaneMeta(selectedThreadId, {
      status: "active",
      createdAt: created,
      isSubagent: true
    });
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
  const laneObj = { lane, color: palette[lane % palette.length], nodes: [] };
  lanes.set(threadId, laneObj);
  laneOrder.push(threadId);

  const y = margin.top + lane * margin.yStep;
  const labelX = Math.max(8, margin.left - 260);

  const labelGroup = document.createElementNS("http://www.w3.org/2000/svg", "g");
  labelGroup.setAttribute("transform", \`translate(\${labelX}, \${y - 52})\`);

  const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
  rect.setAttribute("x", "0");
  rect.setAttribute("y", "0");
  rect.setAttribute("rx", "6");
  rect.setAttribute("class", "lane-label-card");
  rect.setAttribute("width", "1");
  rect.setAttribute("height", "1");
  labelGroup.appendChild(rect);

  const titleText = document.createElementNS("http://www.w3.org/2000/svg", "text");
  titleText.setAttribute("x", 12);
  titleText.setAttribute("y", 20);
  titleText.setAttribute("class", "lane-label-title");
  titleText.textContent = short(threadId);
  labelGroup.appendChild(titleText);

  const metaText = document.createElementNS("http://www.w3.org/2000/svg", "text");
  metaText.setAttribute("x", 12);
  metaText.setAttribute("y", 38);
  metaText.setAttribute("class", "lane-label-meta");
  metaText.textContent = "connecting…";
  labelGroup.appendChild(metaText);

  graphGroup.appendChild(labelGroup);

  const guide = document.createElementNS("http://www.w3.org/2000/svg", "line");
  guide.setAttribute("stroke", "rgba(249, 115, 22, 0.35)");
  guide.setAttribute("stroke-width", "1.5");
  guide.setAttribute("stroke-dasharray", "6 6");
  guide.setAttribute("vector-effect", "non-scaling-stroke");
  graphGroup.insertBefore(guide, labelGroup);

  laneObj.label = { group: labelGroup, rectEl: rect, titleEl: titleText, metaEl: metaText, guideEl: guide };

  layoutLaneLabel(threadId);

  resizeSVG();
  return lane;
}

function updateLaneMeta(threadId, meta = {}) {
  if (!threadId) return;
  const current = laneMeta.get(threadId) || {};
  laneMeta.set(threadId, { ...current, ...meta });
  if (lanes.has(threadId)) applyLaneMeta(threadId);
}

function applyLaneMeta(threadId) {
  const laneObj = lanes.get(threadId);
  if (!laneObj?.label) return;
  const meta = laneMeta.get(threadId) || {};

  const baseTitle =
    meta.title ||
    meta.agentName ||
    meta.agentType ||
    (threadId === mainThreadId ? "Root Agent" : meta.isSubagent ? "Subagent" : "Agent");
  laneObj.label.titleEl.textContent = baseTitle;

  const detailParts = [short(threadId)];
  if (meta.status) detailParts.push(String(meta.status).replace(/_/g, " "));
  if (meta.model) detailParts.push(meta.model);
  if (meta.createdAt) detailParts.push(formatRelativeTime(meta.createdAt));

  const lines = [];
  const maxChars = 32;
  let current = "";
  for (const part of detailParts) {
    if (!part) continue;
    if (!current) {
      current = part;
      continue;
    }
    const candidate = \`\${current} • \${part}\`;
    if (candidate.length > maxChars) {
      lines.push(current);
      current = part;
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(current);
  if (!lines.length) lines.push("listening…");

  const metaEl = laneObj.label.metaEl;
  while (metaEl.firstChild) metaEl.removeChild(metaEl.firstChild);
  metaEl.setAttribute("x", 12);
  metaEl.setAttribute("y", 38);

  lines.forEach((line, index) => {
    const tspan = document.createElementNS("http://www.w3.org/2000/svg", "tspan");
    tspan.setAttribute("x", "12");
    tspan.setAttribute("dy", index === 0 ? "0" : "14");
    tspan.textContent = line;
    metaEl.appendChild(tspan);
  });

  layoutLaneLabel(threadId);
}

function layoutLaneLabel(threadId) {
  const laneObj = lanes.get(threadId);
  if (!laneObj?.label) return;
  const { group, rectEl, titleEl, metaEl, guideEl } = laneObj.label;
  const laneIndex = laneObj.lane;
  const y = margin.top + laneIndex * margin.yStep;

  const titleBox = titleEl.getBBox();
  const metaBox = metaEl.getBBox();
  const contentWidth = Math.max(titleBox.x + titleBox.width, metaBox.x + metaBox.width);
  const contentHeight = Math.max(titleBox.y + titleBox.height, metaBox.y + metaBox.height);

  const width = Math.max(180, contentWidth + 20);
  const height = Math.max(52, contentHeight + 14);
  const labelX = Math.max(8, margin.left - width - 44);
  const topY = y - height - 14;

  group.setAttribute("transform", \`translate(\${labelX}, \${topY})\`);
  rectEl.setAttribute("width", String(width));
  rectEl.setAttribute("height", String(height));

  guideEl.setAttribute("x1", String(labelX + width + 18));
  guideEl.setAttribute("y1", y);
  guideEl.setAttribute("x2", String(margin.left - 20));
  guideEl.setAttribute("y2", y);
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
  t.setAttribute("text-anchor","middle"); t.setAttribute("font-size","11"); t.setAttribute("fill","var(--muted)");
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

function drawEdge(x1, y1, x2, y2, dashed) {
  if (dashed) {
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    const midX = (x1 + x2) / 2;
    const curve = Math.max(40, Math.abs(y1 - y2) * 0.6);
    const c1y = y1 < y2 ? y1 + curve : y1 - curve;
    const c2y = y2 > y1 ? y2 - curve : y2 + curve;
    path.setAttribute("d", \`M \${x1} \${y1} C \${midX} \${c1y}, \${midX} \${c2y}, \${x2} \${y2}\`);
    path.setAttribute("fill", "none");
    path.setAttribute("stroke", "rgba(249, 115, 22, 0.7)");
    path.setAttribute("stroke-width", "3");
    path.setAttribute("stroke-linecap", "round");
    path.setAttribute("stroke-dasharray", "10 6");
    path.setAttribute("vector-effect", "non-scaling-stroke");
    graphGroup.insertBefore(path, graphGroup.firstChild || null);
    return;
  }

  const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
  line.setAttribute("x1", x1);
  line.setAttribute("y1", y1);
  line.setAttribute("x2", x2);
  line.setAttribute("y2", y2);
  line.setAttribute("stroke", "rgba(148, 163, 184, 0.6)");
  line.setAttribute("stroke-width", "1.5");
  line.setAttribute("vector-effect", "non-scaling-stroke");
  line.setAttribute("marker-end", \`url(#\${arrowId})\`);
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
      updateLaneMeta(threadId, { status: "running" });
      addNode(threadId, "tick", \`tick #\${ev.data?.step ?? "?"}\`, ev);
      break;
    }
    case "model.started": {
      const modelName = ev.data?.model ?? "";
      updateLaneMeta(threadId, { status: "running", model: modelName });
      addNode(threadId, "model", \`model: \${modelName}\`, ev);
      break;
    }
    case "tool.output": {
      const name = ev.data?.toolName ?? "tool";
      addNode(threadId, "tool", \`\${name} ✓\`, ev);
      break;
    }
    case "tool.error": {
      const name = ev.data?.toolName ?? "tool";
      updateLaneMeta(threadId, { status: "error" });
      addNode(threadId, "error", \`\${name} ✗\`, ev);
      break;
    }
    case "run.paused": {
      const r = ev.data?.reason ?? "paused";
      updateLaneMeta(threadId, { status: "paused" });
      addNode(threadId, "paused", \`paused (\${r})\`, ev);
      break;
    }
    case "run.resumed": {
      updateLaneMeta(threadId, { status: "running" });
      addNode(threadId, "tick", "resumed", ev);
      break;
    }
    case "agent.completed": {
      updateLaneMeta(threadId, { status: "completed" });
      addNode(threadId, "done", "done ✓", ev);
      break;
    }
    case "agent.error": {
      updateLaneMeta(threadId, { status: "error" });
      addNode(threadId, "error", "error", ev);
      break;
    }
    case "subagent.spawned": {
      const child = ev.data?.childThreadId;
      updateLaneMeta(child, { status: "spawning", isSubagent: true });
      const spawnKey = addNode(threadId, "tool", \`spawn \${short(child)}\`, ev);
      childSpawnMap.set(child, spawnKey);
      if (child) connectThreadWS(child);
      break;
    }
    case "subagent.completed": {
      const child = ev.data?.childThreadId;
      updateLaneMeta(child, { status: "completed" });
      const doneKey = addNode(threadId, "tool", \`child \${short(child)} ✓\`, ev);
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
      if (t === "checkpoint.saved") {
        const lane = laneFor(threadId);
        const prevKey = lastNodePerLane.get(lane);
        const prev = prevKey && nodeMap.get(prevKey);
        if (prev) {
          const dot = document.createElementNS("http://www.w3.org/2000/svg", "circle");
          dot.setAttribute("cx", prev.x + 10);
          dot.setAttribute("cy", prev.y - 14);
          dot.setAttribute("r", 3);
          dot.setAttribute("fill", "#64748b");
          graphGroup.appendChild(dot);
        }
      }
  }

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
    updateLaneMeta(threadId, { status: "listening" });
    if (threadId === mainThreadId) updateConnectionStatus(true);
  };
  socket.onclose = ()=>{
    console.log(\`[ws] \${threadId} closed\`);
    updateLaneMeta(threadId, { status: "offline" });
    if (threadId === mainThreadId) updateConnectionStatus(false);
  };
  socket.onmessage = (m)=>{
    try {
      const ev = JSON.parse(m.data);
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

  if (Array.isArray(subagents)) {
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
        agentType: link.agentType,
        isSubagent: true
      });
      updateLaneMeta(childId, {
        title: link.agentName || link.agentType || "Subagent",
        agentName: link.agentName,
        agentType: link.agentType,
        status: link.status,
        createdAt: createdAtIso,
        isSubagent: true,
        report: link.report
      });
    }
  }

  if (
    selectedThreadId &&
    !latestThreads.some((t) => t.id === selectedThreadId) &&
    !extraThreads.has(selectedThreadId)
  ) {
    const created = new Date().toISOString();
    extraThreads.set(selectedThreadId, {
      id: selectedThreadId,
      createdAt: created,
      isSubagent: true,
      status: "active"
    });
    updateLaneMeta(selectedThreadId, {
      status: "active",
      createdAt: created,
      isSubagent: true
    });
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

  const buildToolCall = (titleText, bodyText) => {
    const wrapper = document.createElement("div");
    wrapper.className = "tool-call collapsed";

    const header = document.createElement("div");
    header.className = "tool-call-header";

    const heading = document.createElement("span");
    heading.className = "tool-call-title";
    heading.textContent = titleText;
    header.appendChild(heading);

    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "tool-call-toggle";
    header.appendChild(toggle);

    wrapper.appendChild(header);

    const body = document.createElement("pre");
    body.className = "tool-call-body";
    body.textContent = bodyText;
    wrapper.appendChild(body);

    const updateToggle = () => {
      const collapsed = wrapper.classList.contains("collapsed");
      toggle.textContent = collapsed ? "Show output" : "Hide output";
      toggle.setAttribute("aria-expanded", String(!collapsed));
    };

    updateToggle();
    toggle.addEventListener("click", () => {
      wrapper.classList.toggle("collapsed");
      updateToggle();
    });

    return wrapper;
  };

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
        const title = call.name || "tool";
        const body = JSON.stringify(call.args ?? {}, null, 2);
        content.appendChild(buildToolCall(title, body));
      }
    } else if (role === "tool") {
      const title = msg.toolName || msg.name || "Tool output";
      const body = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content ?? "", null, 2);
      content.appendChild(buildToolCall(title, body));
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
    updateLaneMeta(meta.id, {
      title: meta.agentName || meta.agentType || (meta.isSubagent ? "Subagent" : "Agent"),
      agentName: meta.agentName,
      agentType: meta.agentType,
      status: meta.status,
      createdAt: meta.createdAt,
      isSubagent: meta.isSubagent
    });

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
