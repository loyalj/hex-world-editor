/**
 * The editor's terrain locks: terrain indices whose cells no editing tool may
 * modify. Like the selection mask this constrains writes globally — but where
 * the selection is spatial and a snapshot, locks are attribute-based and
 * dynamic: a cell is protected because of what it holds *now*, so a freshly
 * painted cell of a locked terrain is instantly protected too. Enforced
 * through {@link SceneApi.editable}; fog exploration and the selection itself
 * are exempt (they edit no map content). Unlike the selection, locks are part
 * of the saved document.
 */
export class LockModel {
  private locked = new Set<number>();
  /** Fires after any change — the lock UI and dirty tracking hang here. */
  onChange?: () => void;

  get size(): number { return this.locked.size; }

  isLocked(terrain: number): boolean { return this.locked.has(terrain); }

  setLocked(terrain: number, locked: boolean): void {
    if (locked === this.locked.has(terrain)) return;
    if (locked) this.locked.add(terrain); else this.locked.delete(terrain);
    this.onChange?.();
  }

  toggle(terrain: number): void { this.setLocked(terrain, !this.locked.has(terrain)); }

  unlockAll(): void {
    if (this.locked.size === 0) return;
    this.locked.clear();
    this.onChange?.();
  }

  /** The locked indices in stable order — what a save file records. */
  indices(): number[] { return [...this.locked].sort((a, b) => a - b); }

  /** Replace the whole set from loaded/restored state. */
  setIndices(indices: Iterable<number>): void {
    this.locked = new Set(indices);
    this.onChange?.();
  }
}
