import * as Y from "yjs";

/**
 * A code update stored in the database
 */
export interface CodeUpdate {
  version: number;
  timestamp: Date;
  update: Uint8Array;
}

/**
 * Type for the SQL template literal function from Agent
 * Using `unknown` for values since Agent's sql accepts various types including Uint8Array for BLOBs
 */
export type SqlFunction = <T = Record<string, unknown>>(
  strings: TemplateStringsArray,
  ...values: (string | number | boolean | null | Uint8Array)[]
) => T[];

/**
 * Minimum size threshold for creating a snapshot
 */
const MIN_SNAPSHOT_THRESHOLD = 10000; // 10KB

/**
 * YjsStorage - Manages Yjs document persistence in SQLite
 *
 * The document structure is: Y.Map<Y.Text> where keys are filenames
 * and values are the file contents as Y.Text (for fine-grained updates).
 *
 * Version tracking:
 * - Each update increments the version
 * - Version is used in LOADER IDs so code changes create new isolates
 * - Snapshots are created periodically to optimize replay
 *
 * Performance note:
 * Currently rebuilds the document from storage on each operation.
 * Future optimization: cache the document in memory and apply updates
 * incrementally instead of rebuilding each time.
 */
export class YjsStorage {
  private sql: SqlFunction;
  private codeVersion = 0;
  private snapshotMetrics: { snapshotSize: number; logSize: number } | null =
    null;

  constructor(sql: SqlFunction) {
    this.sql = sql;
    this.initTables();
    this.loadVersion();
  }

  /**
   * Initialize database tables
   */
  private initTables(): void {
    // Code updates table
    this.sql`
      CREATE TABLE IF NOT EXISTS code_updates (
        version INTEGER PRIMARY KEY,
        timestamp TEXT NOT NULL,
        data BLOB NOT NULL
      )
    `;

    // Snapshots table (for efficient replay)
    this.sql`
      CREATE TABLE IF NOT EXISTS code_snapshots (
        version INTEGER PRIMARY KEY,
        timestamp TEXT NOT NULL,
        data BLOB NOT NULL
      )
    `;

    // Version tracking
    this.sql`
      CREATE TABLE IF NOT EXISTS code_version (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        version INTEGER NOT NULL
      )
    `;
  }

  /**
   * Load the current version from storage
   */
  private loadVersion(): void {
    const rows = this.sql<{
      version: number;
    }>`SELECT version FROM code_version WHERE id = 1`;
    if (rows.length > 0) {
      this.codeVersion = rows[0].version;
    } else {
      // Initialize version to 0
      this.sql`INSERT INTO code_version (id, version) VALUES (1, 0)`;
      this.codeVersion = 0;
    }
  }

  /**
   * Get the current code version
   */
  getVersion(): number {
    return this.codeVersion;
  }

  /**
   * Bump the version and persist it
   */
  private bumpVersion(): number {
    this.codeVersion++;
    this
      .sql`UPDATE code_version SET version = ${this.codeVersion} WHERE id = 1`;
    return this.codeVersion;
  }

  /**
   * Initialize the document with default files
   * Call this when creating a new session
   */
  initializeDocument(files: Record<string, string> = {}): number {
    // Check if already initialized
    if (this.codeVersion > 0) {
      return this.codeVersion;
    }

    // Create initial Y.Doc
    const ydoc = new Y.Doc();
    const filesMap = ydoc.getMap<Y.Text>();

    // Default files if none provided
    const defaultFiles: Record<string, string> = {
      "README.md": "# Project\n\nThis is your workspace.",
      ...files
    };

    // Add files to the document
    for (const [filename, content] of Object.entries(defaultFiles)) {
      const text = new Y.Text();
      text.insert(0, content);
      filesMap.set(filename, text);
    }

    // Store the initial state as version 1
    const update = Y.encodeStateAsUpdateV2(ydoc);
    const version = this.bumpVersion();
    const timestamp = new Date().toISOString();

    this
      .sql`INSERT INTO code_updates (version, timestamp, data) VALUES (${version}, ${timestamp}, ${update})`;

    return version;
  }

  /**
   * Replay updates from storage to reconstruct state
   *
   * @param fromVersion - Start version (exclusive, use 0 for beginning)
   * @param toVersion - End version (inclusive) or "current"
   * @param apply - Callback to apply each update
   * @returns Final version number
   */
  replayUpdates(
    fromVersion: number,
    toVersion: number | "current",
    apply: (update: CodeUpdate) => void
  ): number {
    type SnapshotRow = {
      version: number;
      timestamp: string;
      yjs_data: Uint8Array;
    };
    type UpdateRow = {
      version: number;
      timestamp: string;
      yjs_data: Uint8Array;
    };

    // Find the best snapshot to start from
    let snapshotRows: SnapshotRow[];
    if (toVersion === "current") {
      snapshotRows = this.sql<SnapshotRow>`
        SELECT version, timestamp, data as yjs_data 
        FROM code_snapshots 
        WHERE version > ${fromVersion}
        ORDER BY version DESC 
        LIMIT 1
      `;
    } else {
      snapshotRows = this.sql<SnapshotRow>`
        SELECT version, timestamp, data as yjs_data 
        FROM code_snapshots 
        WHERE version > ${fromVersion} AND version <= ${toVersion}
        ORDER BY version DESC 
        LIMIT 1
      `;
    }

    let startVersion = fromVersion;
    let snapshotSize = 0;
    let logSize = 0;

    if (snapshotRows.length > 0) {
      // Apply the snapshot first
      const row = snapshotRows[0];
      const snapshot: CodeUpdate = {
        version: row.version,
        timestamp: new Date(row.timestamp),
        update: row.yjs_data
      };
      apply(snapshot);
      startVersion = snapshot.version;
      snapshotSize = snapshot.update.length;
    } else if (fromVersion === 0) {
      // No snapshot - check if version 1 exists and treat it as a de-facto snapshot
      const v1Rows = this.sql<UpdateRow>`
        SELECT version, timestamp, data as yjs_data FROM code_updates WHERE version = 1
      `;
      if (v1Rows.length > 0) {
        const row = v1Rows[0];
        const v1Update: CodeUpdate = {
          version: row.version,
          timestamp: new Date(row.timestamp),
          update: row.yjs_data
        };
        apply(v1Update);
        startVersion = 1;
        snapshotSize = v1Update.update.length;
      }
    }

    // Apply remaining updates
    let updateRows: UpdateRow[];
    if (toVersion === "current") {
      updateRows = this.sql<UpdateRow>`
        SELECT version, timestamp, data as yjs_data 
        FROM code_updates 
        WHERE version > ${startVersion}
        ORDER BY version ASC
      `;
    } else {
      updateRows = this.sql<UpdateRow>`
        SELECT version, timestamp, data as yjs_data 
        FROM code_updates 
        WHERE version > ${startVersion} AND version <= ${toVersion}
        ORDER BY version ASC
      `;
    }

    let finalVersion = startVersion;
    for (const row of updateRows) {
      const update: CodeUpdate = {
        version: row.version,
        timestamp: new Date(row.timestamp),
        update: row.yjs_data
      };
      apply(update);
      finalVersion = update.version;
      logSize += update.update.length;
    }

    // Store metrics for snapshot decision
    this.snapshotMetrics = { snapshotSize, logSize };

    return finalVersion;
  }

  /**
   * Build a Y.Doc from stored updates
   *
   * @param version - Version to build or "current" for latest
   * @returns The constructed Y.Doc and its version
   */
  buildYDoc(version: number | "current"): { ydoc: Y.Doc; version: number } {
    const ydoc = new Y.Doc();
    const finalVersion = this.replayUpdates(
      0,
      version,
      (update: CodeUpdate) => {
        // SQLite BLOBs may come back as ArrayBuffer, ensure Uint8Array
        const updateData =
          update.update instanceof Uint8Array
            ? update.update
            : new Uint8Array(update.update as ArrayBufferLike);
        Y.applyUpdateV2(ydoc, updateData);
      }
    );
    return { ydoc, version: finalVersion };
  }

  /**
   * Apply a Yjs update to the code
   *
   * @param update - Yjs-encoded update (V2 format)
   * @returns New version number
   */
  updateCode(update: Uint8Array): number {
    const version = this.bumpVersion();
    const timestamp = new Date().toISOString();

    this
      .sql`INSERT INTO code_updates (version, timestamp, data) VALUES (${version}, ${timestamp}, ${update})`;

    // Check if we should create a snapshot
    if (this.snapshotMetrics) {
      this.snapshotMetrics.logSize += update.length;

      if (
        this.snapshotMetrics.logSize >
        Math.max(this.snapshotMetrics.snapshotSize, MIN_SNAPSHOT_THRESHOLD)
      ) {
        // Create a snapshot
        const { ydoc } = this.buildYDoc("current");
        const snapshotUpdate = Y.encodeStateAsUpdateV2(ydoc);

        this
          .sql`INSERT OR REPLACE INTO code_snapshots (version, timestamp, data) VALUES (${version}, ${timestamp}, ${snapshotUpdate})`;

        this.snapshotMetrics = {
          snapshotSize: snapshotUpdate.length,
          logSize: 0
        };
      }
    }

    return version;
  }

  /**
   * Get all files from the current code state
   */
  getFiles(): Record<string, string> {
    const { ydoc } = this.buildYDoc("current");
    const files: Record<string, string> = {};

    for (const [filename, text] of ydoc.getMap<Y.Text>()) {
      files[filename] = text.toString();
    }

    return files;
  }

  /**
   * Read a specific file
   */
  readFile(path: string): string | null {
    const { ydoc } = this.buildYDoc("current");
    const filesMap = ydoc.getMap<Y.Text>();
    const text = filesMap.get(path);
    return text ? text.toString() : null;
  }

  /**
   * Write a file (creates or replaces)
   * Returns the new version number
   */
  writeFile(path: string, content: string): number {
    const { ydoc } = this.buildYDoc("current");
    const filesMap = ydoc.getMap<Y.Text>();

    // Create a transaction that replaces the file content
    ydoc.transact(() => {
      const existing = filesMap.get(path);
      if (existing) {
        // Delete existing content and insert new
        existing.delete(0, existing.length);
        existing.insert(0, content);
      } else {
        // Create new file
        const text = new Y.Text();
        text.insert(0, content);
        filesMap.set(path, text);
      }
    });

    // Encode the update and store it
    const update = Y.encodeStateAsUpdateV2(ydoc);
    return this.updateCode(update);
  }

  /**
   * Edit a file using search and replace
   * Returns the new version number or null if search not found
   */
  editFile(path: string, search: string, replace: string): number | null {
    const { ydoc } = this.buildYDoc("current");
    const filesMap = ydoc.getMap<Y.Text>();
    const text = filesMap.get(path);

    if (!text) {
      return null;
    }

    const content = text.toString();
    const index = content.indexOf(search);

    if (index === -1) {
      return null;
    }

    // Apply the edit
    ydoc.transact(() => {
      text.delete(index, search.length);
      text.insert(index, replace);
    });

    // Encode the update and store it
    const update = Y.encodeStateAsUpdateV2(ydoc);
    return this.updateCode(update);
  }

  /**
   * Delete a file
   */
  deleteFile(path: string): number | null {
    const { ydoc } = this.buildYDoc("current");
    const filesMap = ydoc.getMap<Y.Text>();

    if (!filesMap.has(path)) {
      return null;
    }

    ydoc.transact(() => {
      filesMap.delete(path);
    });

    const update = Y.encodeStateAsUpdateV2(ydoc);
    return this.updateCode(update);
  }

  /**
   * List all files
   */
  listFiles(): string[] {
    const { ydoc } = this.buildYDoc("current");
    return Array.from(ydoc.getMap<Y.Text>().keys());
  }
}
