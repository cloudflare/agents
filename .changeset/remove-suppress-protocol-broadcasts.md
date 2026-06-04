---
"agents": patch
---

Remove the now-redundant `_suppressProtocolBroadcasts` facet-bootstrap guard.

This flag was added in #1425 to stop `_broadcastProtocol()` from enumerating the
parent DO's WebSockets during facet bootstrap (the cross-DO Native I/O crash,
#1410/#1677). The proper fix in #1679 makes `getConnections()`/`broadcast()`
facet-safe at the source — on a facet they return only virtual sub-agent
connections and route through the parent bridge, never touching the parent's own
sockets. With that, suppressing broadcasts during bootstrap is unnecessary, and
removing it also lets legitimate state sync run during the bootstrap window.

The separate request/WebSocket/email native-handle clearing from #1425 is
retained, since #1679 does not cover that vector.
