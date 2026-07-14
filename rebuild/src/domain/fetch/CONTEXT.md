# Fetch

A conservative, off-by-default, allowlisted, GET-only outbound HTTP tool. It gives
the model read-only web / service-binding access behind strict safety rails. See
the [context map](../../../CONTEXT-MAP.md).

## Language

**Fetch tool**:
The model tool performing allowlisted read-only HTTP GETs (`fetch_url`, plus one
`fetch_<name>` per binding).
_Avoid_: http tool, web tool

**Allowlist**:
The URL/path patterns (glob, via `globToRegExp`) that authorize a fetch; matching
compares scheme, host, port, and path.
_Avoid_: whitelist, allowed hosts

**Bare origin**:
An allowlist entry naming just an origin (`https://example.com`) that authorizes
that origin plus every subpath under it.

**Binding**:
A named service-binding fetch target with its own path allowlist and fixed
server-side headers, surfaced as a `fetch_<name>` tool.

**Fixed headers**:
Server-side headers attached to a binding request, never shown to the model and
stripped on cross-origin redirects.

**modelHeaderAllowlist**:
The set of headers the model is permitted to set (default: accept,
accept-language, range).

**Forbidden host**:
A private / loopback / link-local / `.internal` host that is always blocked, even
if it appears on the allowlist.
_Avoid_: blocked host

**Workspace spillover**:
Writing a large or binary response body to the workspace and returning a path
instead of an inline body.
_Avoid_: auto-spill (loosely), overflow

**Fetch result**:
The structured, never-thrown outcome of a fetch: a success (status, final URL,
content type, bytes, body/json/path) or a failure carrying a specific failure code.
