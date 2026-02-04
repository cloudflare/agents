import { Agent, callable } from "agents";

export class SqlAgent extends Agent<Env, {}> {
  @callable({ description: "List all tables in the database" })
  listTables(): unknown[] {
    const cursor = this.sql`
      SELECT name, type FROM sqlite_master 
      WHERE type IN ('table', 'index') 
      ORDER BY type, name
    `;
    return [...cursor];
  }

  @callable({ description: "Get table schema" })
  getTableSchema(tableName: string): unknown[] {
    const cursor = this.ctx.storage.sql.exec(`PRAGMA table_info(${tableName})`);
    return [...cursor];
  }

  @callable({ description: "Insert a custom record" })
  insertRecord(key: string, value: string): void {
    this.sql`
      CREATE TABLE IF NOT EXISTS playground_data (
        key TEXT PRIMARY KEY,
        value TEXT,
        created_at INTEGER DEFAULT (unixepoch())
      )
    `;
    this.sql`
      INSERT OR REPLACE INTO playground_data (key, value) 
      VALUES (${key}, ${value})
    `;
  }

  @callable({ description: "Get all custom records" })
  getRecords(): unknown[] {
    this.sql`
      CREATE TABLE IF NOT EXISTS playground_data (
        key TEXT PRIMARY KEY,
        value TEXT,
        created_at INTEGER DEFAULT (unixepoch())
      )
    `;
    const cursor = this
      .sql`SELECT * FROM playground_data ORDER BY created_at DESC`;
    return [...cursor];
  }

  @callable({ description: "Execute a SELECT query" })
  executeQuery(query: string): unknown[] {
    const trimmed = query.trim().toUpperCase();
    if (!trimmed.startsWith("SELECT")) {
      throw new Error("Only SELECT queries are allowed");
    }
    const cursor = this.ctx.storage.sql.exec(query);
    return [...cursor];
  }
}
