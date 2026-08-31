import { offsetNeighbor } from '@loyalj/hex-world';
import { EDGE_DIRS } from './tools/hexPath.ts';

/**
 * The editor's selection mask: a set of cells the selection tools build up and
 * other tools honour as a constraint. Deliberately knows nothing about the
 * map's contents and never edits it — selection is pure view/tool state,
 * outside the undo history. The whole-set operations take the map dimensions
 * as arguments rather than holding a map reference, keeping the model pure.
 */

/** How a selection gesture folds into the current set. */
export type SelectionOp = 'replace' | 'add' | 'subtract' | 'intersect';

/**
 * The shared modifier convention: Shift adds, Alt carves out, both together
 * keep only the overlap, plain replaces.
 */
export function selectionOpFor(e: { shiftKey: boolean; altKey: boolean }): SelectionOp {
  if (e.shiftKey && e.altKey) return 'intersect';
  if (e.shiftKey) return 'add';
  if (e.altKey) return 'subtract';
  return 'replace';
}

export class SelectionModel {
  /** Packed (row << 16) | col — fine for any map under 65k cells a side. */
  private keys = new Set<number>();
  /** Fires after any change; the scene hangs its highlight rebuild here. */
  private readonly onChange: () => void;
  /**
   * Fires once per finished gesture that changed the set, with before/after
   * snapshots — the undo integration hangs here. Unset in contexts without a
   * history (tests, tools running standalone).
   */
  onCommit?: (before: ReadonlySet<number>, after: ReadonlySet<number>) => void;
  /** Open gesture's starting snapshot, or null outside a gesture. */
  private gestureBefore: Set<number> | null = null;
  private gestureDirty = false;

  constructor(onChange: () => void) {
    this.onChange = onChange;
  }

  /**
   * Batch the mutations until {@link endGesture} into one onCommit — a drag
   * stroke is one undo step, not one per cell. Mutations outside an explicit
   * gesture commit themselves individually.
   */
  beginGesture(): void {
    if (this.gestureBefore) return;
    this.gestureBefore = new Set(this.keys);
    this.gestureDirty = false;
  }

  endGesture(): void {
    const before = this.gestureBefore;
    this.gestureBefore = null;
    if (!before || !this.gestureDirty) return;
    this.onCommit?.(before, new Set(this.keys));
  }

  private mutate(fn: () => void): void {
    if (this.gestureBefore) {
      fn();
      return;
    }
    this.beginGesture();
    fn();
    this.endGesture();
  }

  /** Every mutation funnels change notification through here. */
  private changed(): void {
    this.gestureDirty = true;
    this.onChange();
  }

  /** Replace the whole set from an undo/redo snapshot — never re-commits. */
  restoreKeys(keys: ReadonlySet<number>): void {
    this.keys = new Set(keys);
    this.onChange();
  }

  /**
   * Replace the whole set from loaded/restored state (save files, session
   * restore). Like {@link restoreKeys}, outside the undo stream — a freshly
   * loaded document must not open with a phantom undo entry.
   */
  setCells(cells: Iterable<{ col: number; row: number }>): void {
    const next = new Set<number>();
    for (const { col, row } of cells) next.add((row << 16) | col);
    this.keys = next;
    this.onChange();
  }

  get size(): number { return this.keys.size; }

  has(col: number, row: number): boolean {
    return this.keys.has((row << 16) | col);
  }

  /**
   * Whether editing tools may touch this cell — the enforcement side of the
   * mask. An empty selection constrains nothing; a non-empty one confines
   * every map edit to its cells. Reads are never masked, only writes.
   */
  allows(col: number, row: number): boolean {
    return this.keys.size === 0 || this.keys.has((row << 16) | col);
  }

  cells(): Array<{ col: number; row: number }> {
    return [...this.keys].map(k => ({ col: k & 0xffff, row: k >> 16 }));
  }

  /** Fold a gesture's cells into the set. No-op changes don't fire onChange. */
  apply(cells: Iterable<{ col: number; row: number }>, op: SelectionOp): void {
    this.mutate(() => {
      if (op === 'intersect') {
        const keep = new Set<number>();
        for (const { col, row } of cells) {
          const key = (row << 16) | col;
          if (this.keys.has(key)) keep.add(key);
        }
        const mutated = keep.size !== this.keys.size;
        this.keys = keep;
        if (mutated) this.changed();
        return;
      }
      let mutated = false;
      if (op === 'replace') {
        mutated = this.keys.size > 0;
        this.keys.clear();
      }
      for (const { col, row } of cells) {
        const key = (row << 16) | col;
        if (op === 'subtract') {
          if (this.keys.delete(key)) mutated = true;
        } else if (!this.keys.has(key)) {
          this.keys.add(key);
          mutated = true;
        }
      }
      if (mutated) this.changed();
    });
  }

  clear(): void {
    if (this.keys.size === 0) return;
    this.mutate(() => {
      this.keys.clear();
      this.changed();
    });
  }

  selectAll(width: number, height: number): void {
    if (this.keys.size === width * height) return;
    this.mutate(() => {
      this.keys.clear();
      for (let row = 0; row < height; row++) {
        for (let col = 0; col < width; col++) this.keys.add((row << 16) | col);
      }
      this.changed();
    });
  }

  /** Swap selected and unselected. Inverting an empty selection selects all. */
  invert(width: number, height: number): void {
    if (width * height === 0) return;
    this.mutate(() => {
      const next = new Set<number>();
      for (let row = 0; row < height; row++) {
        for (let col = 0; col < width; col++) {
          const key = (row << 16) | col;
          if (!this.keys.has(key)) next.add(key);
        }
      }
      this.keys = next;
      this.changed();
    });
  }

  /** Add every in-bounds neighbour of the selection — one ring outward. */
  grow(width: number, height: number): void {
    const additions: Array<{ col: number; row: number }> = [];
    for (const key of this.keys) {
      const col = key & 0xffff;
      const row = key >> 16;
      for (let dir = 0; dir < 6; dir++) {
        const nb = offsetNeighbor(col, row, EDGE_DIRS[dir]);
        if (nb.col < 0 || nb.col >= width || nb.row < 0 || nb.row >= height) continue;
        if (!this.keys.has((nb.row << 16) | nb.col)) additions.push(nb);
      }
    }
    this.apply(additions, 'add');
  }

  /**
   * Remove the selection's boundary cells — one ring inward. The map edge is
   * a wall, not a boundary: a cell whose only "missing" neighbours are off the
   * map stays selected, so a full-map selection is stable under shrink.
   */
  shrink(width: number, height: number): void {
    const removals: Array<{ col: number; row: number }> = [];
    for (const key of this.keys) {
      const col = key & 0xffff;
      const row = key >> 16;
      for (let dir = 0; dir < 6; dir++) {
        const nb = offsetNeighbor(col, row, EDGE_DIRS[dir]);
        if (nb.col < 0 || nb.col >= width || nb.row < 0 || nb.row >= height) continue;
        if (!this.keys.has((nb.row << 16) | nb.col)) {
          removals.push({ col, row });
          break;
        }
      }
    }
    this.apply(removals, 'subtract');
  }
}
