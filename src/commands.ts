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

  constructor(edit: MapEdit, chunks: () => ChunkManager) {
    this.edit   = edit;
    this.chunks = chunks;
  }

  execute(): void {
    this.edit.redo();
    this.chunks().markDirtyCells(this.edit.cells);
  }

  undo(): void {
    this.edit.undo();
    this.chunks().markDirtyCells(this.edit.cells);
  }
}
