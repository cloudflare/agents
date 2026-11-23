/**
 * An independent model of one session, for property tests: a tree of rows,
 * a list of overlays, and what the model sees, computed by the rule the
 * read walk implements. No dependency on the Sessions code. Ported from the
 * Sessions test gate's `oracle.mjs`.
 *
 *   row = leaf
 *   while row: if an overlay ends at row (the newest one): show its summary,
 *     row = overlay.resume; else show row, row = row.parent.
 *
 * `resume` is the parent of the overlay's start row when it was stored.
 * Deletes splice rows out; overlays follow the splice.
 */

export const COMPACTION_PREFIX = "compaction_";

type Row = { id: string; parent: string | null; seq: number };
type Overlay = {
  id: string;
  from: string;
  to: string;
  resume: string | null;
  seq: number;
  alive: boolean;
};

export class Oracle {
  readonly rows = new Map<string, Row>();
  readonly overlays: Overlay[] = [];
  #nextSeq = 1;
  #overlaySeq = 1;
  leaf: string | null = null;

  /** `parent` undefined attaches to the newest row. */
  append(id: string, parent?: string | null): boolean {
    if (this.rows.has(id)) return false;
    let p = parent === undefined ? this.leaf : parent;
    if (p !== null && !this.rows.has(p)) p = null;
    this.rows.set(id, { id, parent: p, seq: this.#nextSeq++ });
    this.leaf = id;
    return true;
  }

  isAncestor(a: string, b: string): boolean {
    for (
      let r: string | null = b;
      r !== null;
      r = this.rows.get(r)?.parent ?? null
    ) {
      if (r === a) return true;
    }
    return false;
  }

  /** Whether the anchors can apply; the session refuses those that cannot. */
  canOverlay(from: string, to: string): boolean {
    return (
      this.rows.has(from) && this.rows.has(to) && this.isAncestor(from, to)
    );
  }

  addOverlay(id: string, from: string, to: string): void {
    const start = this.rows.get(from);
    if (!start || !this.canOverlay(from, to)) {
      throw new Error("oracle: invalid overlay");
    }
    this.overlays.push({
      id,
      from,
      to,
      resume: start.parent,
      seq: this.#overlaySeq++,
      alive: true
    });
  }

  /** Splice rows out. Children go to the nearest surviving ancestor. */
  delete(ids: readonly string[]): void {
    const gone = new Set(ids.filter((id) => this.rows.has(id)));
    if (gone.size === 0) return;
    const survivor = (id: string | null): string | null => {
      let r = id;
      while (r !== null && gone.has(r)) r = this.rows.get(r)?.parent ?? null;
      return r;
    };
    for (const row of this.rows.values()) {
      if (!gone.has(row.id) && row.parent !== null && gone.has(row.parent)) {
        row.parent = survivor(row.parent);
      }
    }
    for (const o of this.overlays) {
      if (!o.alive) continue;
      if (o.resume !== null && gone.has(o.resume)) {
        o.resume = survivor(o.resume);
      }
      if (gone.has(o.to)) {
        const to = survivor(o.to);
        // Nothing left between resume and the old end: it covers no row.
        if (to === null || to === o.resume) o.alive = false;
        else o.to = to;
      }
    }
    for (const id of gone) this.rows.delete(id);
    // The newest surviving row is the leaf, and the next row is numbered
    // from it, so a seq can be reused.
    let leaf: string | null = null;
    let best = 0;
    for (const row of this.rows.values()) {
      if (row.seq > best) [best, leaf] = [row.seq, row.id];
    }
    this.leaf = leaf;
    this.#nextSeq = best + 1;
  }

  /** Raw path root → leaf. */
  rawPath(leaf: string | null = this.leaf): string[] {
    const out: string[] = [];
    for (let r = leaf; r !== null; r = this.rows.get(r)?.parent ?? null) {
      out.push(r);
    }
    return out.reverse();
  }

  /** What the model sees, root → leaf, as message ids. */
  visibleIds(leaf: string | null = this.leaf): string[] {
    const ends = new Map<string, Overlay>();
    for (const o of this.overlays) {
      if (!o.alive) continue;
      const current = ends.get(o.to);
      if (!current || current.seq < o.seq) ends.set(o.to, o);
    }
    const out: string[] = [];
    let r = leaf;
    while (r !== null) {
      const o = ends.get(r);
      if (o) {
        out.push(COMPACTION_PREFIX + o.id);
        r = o.resume;
        continue;
      }
      const row = this.rows.get(r);
      if (!row) break;
      out.push(r);
      r = row.parent;
    }
    return out.reverse();
  }
}
