---
"agents": patch
---

Send Browser Run extraction schemas under `response_format.json_schema`, matching the Quick Actions `/json` contract.

Direct `browserExtract()` and `runQuickAction()` callers must rename `response_format.schema` to `response_format.json_schema`. The model-facing `browser_extract` tool still accepts its schema in the top-level `schema` field.
