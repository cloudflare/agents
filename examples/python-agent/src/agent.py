"""
Python Agent base class — mirrors the wire protocol of the TypeScript Agent SDK
so that existing clients (AgentClient, useAgent React hook) can connect unchanged.
"""

import json
import re

from js import Object, Response
from pyodide.ffi import to_js as _to_js
from workers import DurableObject


def to_js(obj):
    return _to_js(obj, dict_converter=Object.fromEntries)


def _camel_to_kebab(name):
    """Convert CamelCase class name to kebab-case (matches TS SDK behavior)."""
    s1 = re.sub(r"(.)([A-Z][a-z]+)", r"\1-\2", name)
    return re.sub(r"([a-z0-9])([A-Z])", r"\1-\2", s1).lower()


# Sentinel so we can distinguish "no initial state provided" from None
_UNSET = object()

STATE_ROW_ID = "cf_state_row_id"
STATE_WAS_CHANGED = "cf_state_was_changed"

# Wire protocol message types — must match packages/agents/src/types.ts
CF_AGENT_STATE = "cf_agent_state"
CF_AGENT_STATE_ERROR = "cf_agent_state_error"
CF_AGENT_IDENTITY = "cf_agent_identity"
RPC = "rpc"


def callable(fn=None, *, description=None, streaming=False):
    """Mark a method as callable via the agent RPC protocol."""
    def decorator(f):
        f._agent_callable = True
        f._agent_callable_meta = {
            "description": description,
            "streaming": streaming,
        }
        return f
    if fn is not None:
        return decorator(fn)
    return decorator


class Agent(DurableObject):
    """
    Python Agent base class that speaks the Agents SDK wire protocol.

    Subclass and override:
      - initial_state: default state value
      - on_connect(ws): called when a WebSocket connects
      - on_message(ws, message): called for non-protocol messages
      - on_close(ws, code, reason, was_clean): called on disconnect
      - on_state_changed(state): called after state is persisted
      - Any methods decorated with @callable for RPC

    Uses WebSocket Hibernation for efficient connection handling.
    """

    initial_state = _UNSET

    def __init__(self, ctx, env):
        super().__init__(ctx, env)
        self.ctx = ctx
        self.env = env
        self._state = _UNSET
        self._init_tables()

    def _init_tables(self):
        self.ctx.storage.sql.exec(
            "CREATE TABLE IF NOT EXISTS cf_agents_state "
            "(id TEXT PRIMARY KEY NOT NULL, state TEXT)"
        )

    # -- State management --

    @property
    def state(self):
        if self._state is not _UNSET:
            return self._state

        # Check if state was previously persisted
        # cursor.toArray() returns a JS array; convert to Python list
        was_changed_rows = list(self.ctx.storage.sql.exec(
            "SELECT state FROM cf_agents_state WHERE id = ?", STATE_WAS_CHANGED
        ).toArray())

        if len(was_changed_rows) > 0:
            rows = list(self.ctx.storage.sql.exec(
                "SELECT state FROM cf_agents_state WHERE id = ?", STATE_ROW_ID
            ).toArray())

            if len(rows) > 0:
                try:
                    self._state = json.loads(rows[0].state)
                    return self._state
                except (json.JSONDecodeError, TypeError):
                    if self.initial_state is not _UNSET:
                        self._state = self.initial_state
                        self._set_state_internal(self.initial_state)
                    else:
                        self.ctx.storage.sql.exec(
                            "DELETE FROM cf_agents_state WHERE id = ?", STATE_ROW_ID
                        )
                        self.ctx.storage.sql.exec(
                            "DELETE FROM cf_agents_state WHERE id = ?", STATE_WAS_CHANGED
                        )
                        return None

            return self._state

        if self.initial_state is _UNSET:
            return None

        self._set_state_internal(self.initial_state)
        return self.initial_state

    def set_state(self, state):
        """Update state, persist to SQLite, and broadcast to connected clients."""
        self._set_state_internal(state)

    def _set_state_internal(self, state, source_ws=None):
        self._state = state

        state_json = json.dumps(state)
        self.ctx.storage.sql.exec(
            "INSERT OR REPLACE INTO cf_agents_state (id, state) VALUES (?, ?)",
            STATE_ROW_ID, state_json,
        )
        self.ctx.storage.sql.exec(
            "INSERT OR REPLACE INTO cf_agents_state (id, state) VALUES (?, ?)",
            STATE_WAS_CHANGED, json.dumps(True),
        )

        msg = json.dumps({"type": CF_AGENT_STATE, "state": state})
        for ws in self.ctx.getWebSockets():
            if source_ws is not None and ws == source_ws:
                continue
            ws.send(msg)

        self.on_state_changed(state)

    # -- SQL helper --

    def sql(self, query, *params):
        """Execute a SQL query against Durable Object SQLite storage."""
        return self.ctx.storage.sql.exec(query, *params)

    # -- WebSocket lifecycle (Hibernation API) --

    def fetch(self, request):
        """Handle HTTP requests. Upgrades WebSocket requests, serves HTML for GET."""
        from js import WebSocketPair

        upgrade = request.headers.get("Upgrade")
        if upgrade and upgrade.lower() == "websocket":
            pair = WebSocketPair.new()
            # WebSocketPair is a JS object with keys "0" and "1" — use Object.values
            sockets = list(Object.values(pair))
            client = sockets[0]
            server = sockets[1]
            self.ctx.acceptWebSocket(server)

            # Send identity and current state immediately after accepting
            server.send(json.dumps({
                "type": CF_AGENT_IDENTITY,
                "name": str(self.ctx.id),
                "agent": _camel_to_kebab(type(self).__name__),
            }))
            current = self.state
            if current is not None:
                server.send(json.dumps({"type": CF_AGENT_STATE, "state": current}))

            self.on_connect(server)

            return Response.new(None, to_js({"status": 101, "webSocket": client}))

        return Response.new(
            json.dumps({"agent": _camel_to_kebab(type(self).__name__), "state": self.state}),
            to_js({"headers": {"Content-Type": "application/json"}}),
        )

    def webSocketMessage(self, ws, message):
        """Handle incoming WebSocket messages (Hibernation API callback)."""
        if isinstance(message, str):
            try:
                parsed = json.loads(message)
            except json.JSONDecodeError:
                self.on_message(ws, message)
                return

            msg_type = parsed.get("type")

            if msg_type == CF_AGENT_STATE:
                new_state = parsed.get("state")
                try:
                    self._set_state_internal(new_state, source_ws=ws)
                except Exception as e:
                    ws.send(json.dumps({
                        "type": CF_AGENT_STATE_ERROR,
                        "error": str(e),
                    }))
                return

            if msg_type == RPC:
                self._handle_rpc(ws, parsed)
                return

            self.on_message(ws, message)
        else:
            self.on_message(ws, message)

    def webSocketClose(self, ws, code, reason, was_clean):
        """Called when WebSocket closes (Hibernation API)."""
        self.on_close(ws, code, reason, was_clean)

    def webSocketError(self, ws, error):
        """Called on WebSocket error (Hibernation API)."""
        self.on_error(ws, error)

    # -- RPC dispatch --

    def _get_callable_methods(self):
        """Discover methods marked with @callable."""
        methods = {}
        for name in dir(self):
            if name.startswith("_"):
                continue
            attr = getattr(type(self), name, None)
            if attr is not None and hasattr(attr, "_agent_callable") and attr._agent_callable:
                methods[name] = attr
        return methods

    def _handle_rpc(self, ws, parsed):
        rpc_id = parsed.get("id")
        method_name = parsed.get("method")
        args = parsed.get("args", [])

        callables = self._get_callable_methods()

        if method_name not in callables:
            ws.send(json.dumps({
                "type": RPC,
                "id": rpc_id,
                "success": False,
                "error": f"Method {method_name} is not callable",
            }))
            return

        try:
            method = getattr(self, method_name)
            result = method(*args)
            ws.send(json.dumps({
                "type": RPC,
                "id": rpc_id,
                "success": True,
                "result": result,
            }))
        except Exception as e:
            ws.send(json.dumps({
                "type": RPC,
                "id": rpc_id,
                "success": False,
                "error": str(e),
            }))

    # -- Override points --

    def on_connect(self, ws):
        """Called when a new WebSocket connection is established."""
        pass

    def on_message(self, ws, message):
        """Called for non-protocol WebSocket messages."""
        pass

    def on_close(self, ws, code, reason, was_clean):
        """Called when a WebSocket connection closes."""
        pass

    def on_error(self, ws, error):
        """Called on WebSocket error."""
        pass

    def on_state_changed(self, state):
        """Called after state has been persisted and broadcast."""
        pass
