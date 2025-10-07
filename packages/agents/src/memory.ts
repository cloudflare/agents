import { HNSW } from "hnsw";

// Types
export type MemoryEntry = {
  content: string;
  metadata?: Record<string, unknown>;
};
export type EmbeddingFn = (texts: string[]) => Promise<number[][]> | number[][];
export type RerankFn = (
  query: string,
  hits: string[]
) => Promise<RerankResult[]> | RerankResult[];
export type RerankResult = { id: number; score: number };

// Helpers
const toBlob = (v: number[]) => Buffer.from(new Float32Array(v).buffer);
const fromBlob = (b: Buffer) =>
  new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4);

// TODO: move this to a config or at least don't YOLO it
const autoHnsw = (size: number): HNSW => {
  const [M, efC] =
    size < 1_000
      ? [32, 200] // Balanced for small sets; higher than original for better graph quality
      : size < 10_000
        ? [48, 300] // Increased density for mid-size
        : size < 50_000
          ? [64, 400] // Dense graph for larger sets
          : [96, 800]; // Max for big data; watch memory

  return new HNSW(M, efC, null, "cosine");
};

// Persistence backend for the IdentityDisk
export interface IdentityDisk {
  name: string;
  size: number;
  description?: string;

  load(
    entries?: MemoryEntry[],
    opts?: { force?: boolean }
  ): void | Promise<void>;

  // return every vector that should be in the index on start-up
  dump():
    | Iterable<{
        id: number;
        vector: number[] | Float32Array;
        entry: MemoryEntry;
      }>
    | Promise<
        Iterable<{
          id: number;
          vector: number[] | Float32Array;
          entry: MemoryEntry;
        }>
      >;

  // add a new entry
  add(entry: MemoryEntry): void | Promise<void>;

  // destroy the source
  destroy(): void | Promise<void>;

  // search the disk
  search(query: string, k?: number): Promise<MemoryEntry[]>;
}

interface IdentityDiskOptions {
  description?: string;
  embeddingFn: EmbeddingFn;
  rerankFn?: RerankFn; // defaults to no reranking, using the raw hits from the index
}

export class IdentityDiskMemory implements IdentityDisk {
  name: string;
  description?: string;

  private hnsw?: HNSW; // todo: move this too maybe?
  private memory: Record<number, MemoryEntry> = {}; // todo: move this
  private embeddingFn: EmbeddingFn;
  private rerank?: RerankFn;
  size = 0;

  constructor(name: string, opts: IdentityDiskOptions) {
    this.name = name;
    this.description = opts.description;
    this.embeddingFn = opts.embeddingFn;
    this.rerank = opts.rerankFn;
  }

  *dump() {
    if (!this.hnsw) throw new Error("IdentityDisk not initialized");

    for (const [id, entry] of Object.entries(this.memory)) {
      const node = this.hnsw.nodes.get(Number(id));
      if (!node) continue; // should never happen
      yield { id: Number(id), vector: node.vector as number[], entry };
    }
  }

  async load(entries?: MemoryEntry[], opts?: { force?: boolean }) {
    const dump = [...this.dump()];
    if (dump.length && !opts?.force && entries?.length) {
      throw new Error("Storage not empty. Set `force: true` to overwrite.");
    }

    // We're importing entries + persisting them at once
    const data: { id: number; vector: number[] }[] = [];
    if (entries?.length) {
      const vectors = await this.embeddingFn(entries.map((e) => e.content));
      for (let i = 0; i < entries.length; i++) {
        const id = i; // or use natural key if you have one
        data.push({ id, vector: vectors[i] });
        this.memory[id] = entries[i];
        // in-memory, so we don't really persist
        // this.src.persist(id, entries[i], vectors[i]);
      }
    } else {
      // We re-initialize the index by reading from the source
      for (const { id, vector, entry } of dump) {
        data.push({ id, vector: Array.from(vector) });
        this.memory[id] = entry;
      }
    }
    this.hnsw = autoHnsw(data.length);
    this.size = data.length;
    await this.hnsw.buildIndex(data);
  }

  async add(entry: MemoryEntry) {
    if (!this.hnsw) throw new Error("IdentityDisk not initialized");

    const [vec] = await this.embeddingFn([entry.content]);
    const id = Math.max(-1, ...Object.keys(this.memory).map(Number)) + 1;
    this.memory[id] = entry;
    await this.hnsw.addPoint(id, vec);
    // in-memory, so we don't really persist
    // this.src.persist(id, entry, vec);
    this.size += 1;
  }

  async search(query: string, k = 1) {
    if (!this.hnsw) throw new Error("IdentityDisk not initialized");

    const [vec] = await this.embeddingFn([query]);
    const knn = this.hnsw.searchKNN(vec, this.rerank ? k * 2 : k);

    const hits = knn.map((r) => this.memory[r.id]);
    if (!this.rerank) return hits;

    const reranked = await this.rerank(
      query,
      hits.map((h) => h.content)
    );
    reranked.sort((a, b) => b.score - a.score);
    return reranked.slice(0, k).map((r) => hits[r.id]);
  }

  async destroy() {
    this.hnsw = undefined; // drop the index
    this.memory = {}; // drop the cache
    this.size = 0;
  }
}

export class IdentityDiskSqlite implements IdentityDisk {
  name: string;
  description?: string;

  private hnsw?: HNSW; // todo: move this too maybe?
  private embeddingFn: EmbeddingFn;
  private rerank?: RerankFn;
  size = 0;

  constructor(
    name: string,
    private sql: SqlStorage,
    opts: IdentityDiskOptions
  ) {
    this.name = name;
    this.sql = sql;

    this.sql
      .exec(`CREATE TABLE IF NOT EXISTS cf_agents_disk_${this.sanitizedName}(
               id INTEGER PRIMARY KEY AUTOINCREMENT,
               content TEXT NOT NULL,
               metadata TEXT,
               embedding BLOB)`);

    this.description = opts.description;
    this.embeddingFn = opts.embeddingFn;
    this.rerank = opts.rerankFn;
  }

  // Sanitize name to ensure it's a valid SQL table name identifier
  private get sanitizedName() {
    return this.name.replace(/[^a-zA-Z0-9_]/g, "_");
  }

  *dump() {
    const rows = this.sql.exec<SqliteSourceRow>(
      `
        SELECT id, content, metadata, embedding
        FROM cf_agents_disk_${this.sanitizedName} ORDER BY id ASC`
    );

    for (const r of rows) {
      const meta = r.metadata ? JSON.parse(r.metadata) : undefined;
      yield {
        id: r.id,
        vector: fromBlob(Buffer.from(r.embedding)),
        entry: { content: r.content, metadata: meta }
      };
    }
  }

  private persist(id: number, entry: MemoryEntry, vector: number[]) {
    this.sql.exec(
      `INSERT OR REPLACE INTO cf_agents_disk_${this.sanitizedName}
       (id,content,metadata,embedding) VALUES (?,?,?,?)`,
      id,
      entry.content,
      entry.metadata ? JSON.stringify(entry.metadata) : null,
      toBlob(vector)
    );
  }

  async load(entries?: MemoryEntry[], opts?: { force?: boolean }) {
    const dump = [...this.dump()];
    if (dump.length && !opts?.force && entries?.length) {
      throw new Error("Storage not empty. Set `force: true` to overwrite.");
    }

    // We're importing entries + persisting them at once
    const data: { id: number; vector: number[] }[] = [];
    if (entries?.length) {
      const vectors = await this.embeddingFn(entries.map((e) => e.content));
      for (let i = 0; i < entries.length; i++) {
        const id = i; // or use natural key if you have one
        data.push({ id, vector: vectors[i] });
        this.persist(id, entries[i], vectors[i]);
      }
    } else {
      // We re-initialize the index by reading from the source
      for (const { id, vector } of dump) {
        data.push({ id, vector: Array.from(vector) });
      }
    }
    this.hnsw = autoHnsw(data.length);
    this.size = data.length;
    await this.hnsw.buildIndex(data);
  }

  async add(entry: MemoryEntry) {
    if (!this.hnsw) throw new Error("IdentityDisk not initialized");

    const [vec] = await this.embeddingFn([entry.content]);
    const id = Math.max(-1, this.size) + 1;
    await this.hnsw.addPoint(id, vec);
    // in-memory, so we don't really persist
    this.persist(id, entry, vec);
    this.size += 1;
  }

  private get(ids: number[]) {
    return this.sql
      .exec<{ content: string; metadata?: string }>(
        `
        SELECT content, metadata
        FROM cf_agents_disk_${this.sanitizedName} WHERE id IN (${ids.map(() => "?").join(",")})`,
        ...ids
      )
      .toArray()
      .map((r) => ({
        content: r.content,
        metadata: r.metadata ? JSON.parse(r.metadata) : undefined
      }));
  }

  async search(query: string, k = 1) {
    if (!this.hnsw) throw new Error("IdentityDisk not initialized");

    const [vec] = await this.embeddingFn([query]);
    const knn = this.hnsw.searchKNN(vec, this.rerank ? k * 2 : k);

    const hits = this.get(knn.map((r) => r.id));
    if (!this.rerank) return hits;

    const reranked = await this.rerank(
      query,
      hits.map((h) => h.content)
    );
    reranked.sort((a, b) => b.score - a.score);
    return reranked.slice(0, k).map((r) => hits[r.id]);
  }

  async destroy() {
    this.hnsw = undefined; // drop the index
    this.size = 0;
    this.sql.exec(`DROP TABLE IF EXISTS cf_agents_disk_${this.sanitizedName}`);
  }
}

interface SqliteSourceRow extends Record<string, SqlStorageValue> {
  id: number;
  content: string;
  metadata: string;
  embedding: ArrayBuffer;
}
