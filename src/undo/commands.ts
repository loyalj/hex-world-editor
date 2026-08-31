import type { ChunkManager, MapEdit } from '@loyalj/hex-world';
import type { Command } from './history.ts';

/**
 * Generic undo/redo command wrapping a committed `MapEdit` transaction.
 * The library snapshots every touched cell across all channels (terrain,
 * elevation, flags, rivers incl. confluence masks, roads, scatter), so one
 * command class covers every paint tool.
 *
 * Takes a ChunkManager accessor because the manager is replaced when terrain
 * definitions change or a pack loads.
 */
export class MapEditCommand implements Command {
  private readonly edit: MapEdit;
  private readonly chunks: () => ChunkManager;
  private readonly afterApply: (() => void) | undefined;

  /**
   * @param afterApply Runs after every apply in either direction. Territory
   *   and resource data lives in the metadata channel, which the snapshot
   *   restores directly — the layers drawing it watch their own dirty flags
   *   and never see that write, so those tools pass a refresh here.
   */
  constructor(edit: MapEdit, chunks: () => ChunkManager, afterApply?: () => void) {
    this.edit       = edit;
    this.chunks     = chunks;
    this.afterApply = afterApply;
  }

  execute(): void {
    this.edit.redo();
    this.chunks().markDirtyCells(this.edit.cells);
    this.afterApply?.();
  }

  undo(): void {
    this.edit.undo();
    this.chunks().markDirtyCells(this.edit.cells);
    this.afterApply?.();
  }
}

/**
 * Undo/redo for one selection-mask gesture, snapshot-based: either direction
 * replaces the whole set. Takes a restore callback rather than the model so
 * the undo layer stays free of selection imports. Transient — the selection
 * isn't part of the saved document, so these entries ride the stack without
 * counting as unsaved changes.
 */
export class SelectionCommand implements Command {
  readonly transient = true;
  private readonly restore: (keys: ReadonlySet<number>) => void;
  private readonly before: ReadonlySet<number>;
  private readonly after: ReadonlySet<number>;

  constructor(
    restore: (keys: ReadonlySet<number>) => void,
    before: ReadonlySet<number>,
    after: ReadonlySet<number>,
  ) {
    this.restore = restore;
    this.before  = before;
    this.after   = after;
  }

  execute(): void { this.restore(this.after); }
  undo(): void { this.restore(this.before); }
}
