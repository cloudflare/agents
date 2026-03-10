---
"agents": patch
---

Simplify Agent storage: schema version gating and single-row state

- Skip redundant DDL migrations on established DOs by tracking schema version in `cf_agents_state`
- Eliminate `STATE_WAS_CHANGED` row — state persistence now uses a single row with row-existence check, correctly handling falsy values (null, 0, false, "")
- Clean up legacy `STATE_WAS_CHANGED` rows during migration
- Add schema DDL snapshot test that breaks if table definitions change without bumping `CURRENT_SCHEMA_VERSION`
- Fix corrupted state test helper that was using incorrect row IDs
