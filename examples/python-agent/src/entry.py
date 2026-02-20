"""
Python Agent example — a simple counter agent that demonstrates
state management, WebSocket connections, and RPC using the
agent wire protocol (compatible with AgentClient / useAgent).
"""

import json
from urllib.parse import urlparse

from js import Response, Object
from pyodide.ffi import to_js as _to_js
from workers import WorkerEntrypoint

from agent import Agent, callable


def to_js(obj):
    return _to_js(obj, dict_converter=Object.fromEntries)


class CounterAgent(Agent):
    """A simple agent that maintains a counter with RPC methods."""

    initial_state = {"count": 0, "last_action": None}

    def on_connect(self, ws):
        print(f"[CounterAgent] Client connected")

    def on_close(self, ws, code, reason, was_clean):
        print(f"[CounterAgent] Client disconnected: {code} {reason}")

    def on_message(self, ws, message):
        print(f"[CounterAgent] Raw message: {message}")

    def on_state_changed(self, state):
        print(f"[CounterAgent] State changed: {state}")

    @callable(description="Increment the counter by a given amount")
    def increment(self, amount=1):
        current = self.state or {"count": 0, "last_action": None}
        new_state = {
            "count": current["count"] + amount,
            "last_action": "increment",
        }
        self.set_state(new_state)
        return new_state["count"]

    @callable(description="Decrement the counter by a given amount")
    def decrement(self, amount=1):
        current = self.state or {"count": 0, "last_action": None}
        new_state = {
            "count": current["count"] - amount,
            "last_action": "decrement",
        }
        self.set_state(new_state)
        return new_state["count"]

    @callable(description="Reset the counter to zero")
    def reset(self):
        self.set_state({"count": 0, "last_action": "reset"})
        return 0

    @callable(description="Get the current count")
    def get_count(self):
        current = self.state or {"count": 0}
        return current["count"]


class Default(WorkerEntrypoint):
    """Worker entrypoint that routes requests to the CounterAgent DO."""

    async def fetch(self, request):
        url = urlparse(request.url)
        path = url.path

        # Serve a simple test page at the root
        if path == "/" or path == "":
            return Response.new(TEST_PAGE_HTML, to_js({
                "headers": {"Content-Type": "text/html"},
            }))

        # Route /agent/* to the Durable Object
        if path.startswith("/agent"):
            # Extract instance name from path, default to "default"
            parts = path.split("/")
            name = parts[2] if len(parts) > 2 and parts[2] else "default"
            obj_id = self.env.COUNTER_AGENT.idFromName(name)
            stub = self.env.COUNTER_AGENT.get(obj_id)
            return await stub.fetch(request)

        return Response.new("Not Found", to_js({"status": 404}))


TEST_PAGE_HTML = """<!DOCTYPE html>
<html>
<head>
  <title>Python Agent - Counter Demo</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      background: #0a0a0a; color: #e0e0e0;
      display: flex; justify-content: center; align-items: center;
      min-height: 100vh;
    }
    .container {
      background: #1a1a1a; border: 1px solid #333; border-radius: 12px;
      padding: 2rem; width: 400px;
    }
    h1 { font-size: 1.2rem; margin-bottom: 0.5rem; color: #f48120; }
    .subtitle { font-size: 0.85rem; color: #888; margin-bottom: 1.5rem; }
    .count {
      font-size: 4rem; font-weight: bold; text-align: center;
      padding: 1.5rem; color: #fff;
    }
    .buttons {
      display: flex; gap: 0.5rem; justify-content: center; margin: 1rem 0;
    }
    button {
      padding: 0.6rem 1.2rem; border: 1px solid #444; border-radius: 6px;
      background: #222; color: #fff; cursor: pointer; font-size: 0.9rem;
    }
    button:hover { background: #333; border-color: #f48120; }
    button.reset { border-color: #666; }
    .log {
      background: #111; border: 1px solid #333; border-radius: 6px;
      padding: 0.75rem; margin-top: 1rem; font-family: monospace;
      font-size: 0.8rem; max-height: 200px; overflow-y: auto;
    }
    .log-entry { padding: 2px 0; color: #888; }
    .log-entry.state { color: #4ade80; }
    .log-entry.rpc { color: #60a5fa; }
    .log-entry.error { color: #f87171; }
    .status {
      display: flex; align-items: center; gap: 0.5rem;
      font-size: 0.8rem; color: #888; margin-bottom: 1rem;
    }
    .dot {
      width: 8px; height: 8px; border-radius: 50%; background: #666;
    }
    .dot.connected { background: #4ade80; }
  </style>
</head>
<body>
  <div class="container">
    <h1>Python Agent</h1>
    <div class="subtitle">Counter demo &mdash; Durable Object with agent wire protocol</div>
    <div class="status">
      <div class="dot" id="dot"></div>
      <span id="status">Connecting...</span>
    </div>
    <div class="count" id="count">—</div>
    <div class="buttons">
      <button onclick="rpc('decrement')">- 1</button>
      <button onclick="rpc('increment')">+ 1</button>
      <button class="reset" onclick="rpc('reset')">Reset</button>
    </div>
    <div class="log" id="log"></div>
  </div>

  <script>
    const log = document.getElementById('log');
    const countEl = document.getElementById('count');
    const dot = document.getElementById('dot');
    const statusEl = document.getElementById('status');
    let ws;
    let rpcId = 0;

    function addLog(text, cls = '') {
      const entry = document.createElement('div');
      entry.className = 'log-entry ' + cls;
      entry.textContent = new Date().toLocaleTimeString() + ' ' + text;
      log.prepend(entry);
    }

    function connect() {
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      ws = new WebSocket(proto + '//' + location.host + '/agent/default');

      ws.onopen = () => {
        dot.classList.add('connected');
        statusEl.textContent = 'Connected';
        addLog('WebSocket connected');
      };

      ws.onclose = () => {
        dot.classList.remove('connected');
        statusEl.textContent = 'Disconnected — reconnecting...';
        addLog('Disconnected', 'error');
        setTimeout(connect, 1000);
      };

      ws.onmessage = (e) => {
        try {
          const msg = JSON.parse(e.data);
          if (msg.type === 'cf_agent_state') {
            countEl.textContent = msg.state?.count ?? '—';
            addLog('State: ' + JSON.stringify(msg.state), 'state');
          } else if (msg.type === 'cf_agent_identity') {
            addLog('Identity: ' + msg.agent + '/' + msg.name);
          } else if (msg.type === 'rpc') {
            if (msg.success) {
              addLog('RPC result: ' + JSON.stringify(msg.result), 'rpc');
            } else {
              addLog('RPC error: ' + msg.error, 'error');
            }
          } else {
            addLog('Unknown: ' + e.data);
          }
        } catch {
          addLog('Raw: ' + e.data);
        }
      };
    }

    function rpc(method, ...args) {
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      const id = String(++rpcId);
      ws.send(JSON.stringify({ type: 'rpc', id, method, args }));
    }

    connect();
  </script>
</body>
</html>
"""
