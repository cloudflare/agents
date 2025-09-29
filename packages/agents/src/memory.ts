import { HNSW } from "hnsw";

// Types
export type MemoryEntry = {
  content: string;
  metadata?: Record<string, string>;
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
interface VectorSource {
  // return every vector that should be in the index on start-up
  dump(): Iterable<{
    id: number;
    vector: number[] | Float32Array;
    entry: MemoryEntry;
  }>;
  // persist one new entry
  persist(id: number, entry: MemoryEntry, vector: number[]): void;

  // destroy the source
  destroy(): Promise<void>;
}

interface IdentityDiskOptions {
  embeddingFn: EmbeddingFn;
  vectorSource?: VectorSource; // defaults to in-memory disk, no persistence
  rerankFn?: RerankFn; // defaults to no reranking, using the raw hits from the index
}

export class IdentityDisk {
  private hnsw?: HNSW; // todo: move this too maybe?
  private memory: Record<number, MemoryEntry> = {}; // todo: move this
  private embeddingFn: EmbeddingFn;
  private rerank?: RerankFn;
  private src: VectorSource;

  constructor(opts: IdentityDiskOptions) {
    this.embeddingFn = opts.embeddingFn;
    this.rerank = opts.rerankFn;

    this.src = opts.vectorSource ?? new MemorySource(this.hnsw, this.memory);
  }

  async load(entries?: MemoryEntry[], opts?: { force?: boolean }) {
    const dump = [...this.src.dump()];
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
        this.src.persist(id, entries[i], vectors[i]);
      }
    } else {
      // We re-initialize the index by reading from the source
      for (const { id, vector, entry } of dump) {
        data.push({ id, vector: Array.from(vector) });
        this.memory[id] = entry;
      }
    }
    this.hnsw = autoHnsw(data.length);
    if (this.src instanceof MemorySource) {
      // re-set the inmemory source to point to the new
      this.src = new MemorySource(this.hnsw, this.memory);
    }
    await this.hnsw.buildIndex(data);
  }

  async add(entry: MemoryEntry) {
    if (!this.hnsw) throw new Error("IdentityDisk not initialized");

    const [vec] = await this.embeddingFn([entry.content]);
    const id = Math.max(-1, ...Object.keys(this.memory).map(Number)) + 1;
    this.memory[id] = entry;
    await this.hnsw.addPoint(id, vec);
    this.src.persist(id, entry, vec);
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
    await this.src.destroy(); // delegate to VectorSource
  }

  *export(): Iterable<MemoryEntry> {
    for (const { entry } of this.src.dump()) {
      yield entry;
    }
  }
}

// Default in-memory backend
class MemorySource implements VectorSource {
  private hnsw?: HNSW;
  private memory: Record<number, MemoryEntry>;

  constructor(hnsw: HNSW | undefined, memory: Record<number, MemoryEntry>) {
    this.hnsw = hnsw;
    this.memory = memory;
  }

  *dump() {
    if (!this.hnsw) throw new Error("IdentityDisk not initialized");

    for (const [id, entry] of Object.entries(this.memory)) {
      const node = this.hnsw.nodes.get(Number(id));
      if (!node) continue; // should never happen
      yield { id: Number(id), vector: node.vector as number[], entry };
    }
  }

  persist(_id: number, _entry: MemoryEntry, _vector: number[]) {} // no-op
  async destroy() {} // no-op
}

interface SqliteSourceRow extends Record<string, SqlStorageValue> {
  id: number;
  content: string;
  metadata: string;
  embedding: ArrayBuffer;
}

// SQLite backend for DOs
export class SqliteSource implements VectorSource {
  constructor(
    private sql: SqlStorage,
    private name: string
  ) {
    sql.exec(`CREATE TABLE IF NOT EXISTS cf_agents_disk_${name}(
               id INTEGER PRIMARY KEY AUTOINCREMENT,
               content TEXT NOT NULL,
               metadata TEXT,
               embedding BLOB)`);
  }
  *dump() {
    const rows = this.sql.exec<SqliteSourceRow>(
      `
        SELECT id, content, metadata, embedding
        FROM cf_agents_disk_${this.name} ORDER BY id ASC`
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
  persist(id: number, entry: MemoryEntry, vector: number[]) {
    this.sql.exec(
      `INSERT OR REPLACE INTO cf_agents_disk_${this.name}
       (id,content,metadata,embedding) VALUES (?,?,?,?)`,
      id,
      entry.content,
      entry.metadata ? JSON.stringify(entry.metadata) : null,
      toBlob(vector)
    );
  }

  async destroy() {
    this.sql.exec(`DROP TABLE IF EXISTS cf_agents_disk_${this.name}`);
  }
}
