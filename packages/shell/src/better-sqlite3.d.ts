declare module "better-sqlite3" {
  class Database {
    constructor(filename: string, options?: Record<string, unknown>);
    prepare(sql: string): Database.Statement;
    close(): void;
  }

  namespace Database {
    interface Statement {
      all(...params: unknown[]): Record<string, unknown>[];
      run(...params: unknown[]): { changes: number };
      columns(): { name: string }[];
    }
  }

  export default Database;
}
