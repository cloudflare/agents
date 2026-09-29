---
"agents": patch
---

`cdp.spec()` and `loadCdpSpec()` now keep each command's `parameters` and `returns`, event parameters, and type details (`type`, `enum`, `properties`, `items`, plus `experimental`/`deprecated` flags). Previously normalization kept only names and descriptions, so the model could find a CDP method but not how to call it. Every `$ref` is domain-qualified (`"Page.FrameId"`) so it matches a type's `name`. `CdpField` and `CdpItems` are exported from `agents/browser`.
