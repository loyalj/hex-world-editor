import type { HexMap, ChunkManager } from 'hex-world';
import type { Command } from './history.ts';

interface CellEdit<T> {
  col: number;
  row: number;
  prev: T;
  next: T;
}

export class TerrainStrokeCommand implements Command {
  private map: HexMap;
  private chunks: ChunkManager;
  private edits: CellEdit<number>[];

  constructor(map: HexMap, chunks: ChunkManager, edits: CellEdit<number>[]) {
    this.map    = map;
    this.chunks = chunks;
    this.edits  = edits;
  }

  execute(): void {
    for (const e of this.edits) {
      this.map.setTerrain(e.col, e.row, e.next);
      this.chunks.markDirty(e.col, e.row);
    }
  }

  undo(): void {
    for (const e of this.edits) {
      this.map.setTerrain(e.col, e.row, e.prev);
      this.chunks.markDirty(e.col, e.row);
    }
  }
}

export class ElevationStrokeCommand implements Command {
  private map: HexMap;
  private chunks: ChunkManager;
  private edits: CellEdit<number>[];

  constructor(map: HexMap, chunks: ChunkManager, edits: CellEdit<number>[]) {
    this.map    = map;
    this.chunks = chunks;
    this.edits  = edits;
  }

  execute(): void {
    for (const e of this.edits) {
      this.map.setElevation(e.col, e.row, e.next);
      this.chunks.markDirty(e.col, e.row);
    }
  }

  undo(): void {
    for (const e of this.edits) {
      this.map.setElevation(e.col, e.row, e.prev);
      this.chunks.markDirty(e.col, e.row);
    }
  }
}

interface PaintEdit {
  col: number;
  row: number;
  prevTerrain: number;
  nextTerrain: number;
  prevElev: number | null; // null = elevation unchanged
  nextElev: number | null;
}

export class PaintTerrainStrokeCommand implements Command {
  private map: HexMap;
  private chunks: ChunkManager;
  private edits: PaintEdit[];

  constructor(map: HexMap, chunks: ChunkManager, edits: PaintEdit[]) {
    this.map    = map;
    this.chunks = chunks;
    this.edits  = edits;
  }

  execute(): void {
    for (const e of this.edits) {
      this.map.setTerrain(e.col, e.row, e.nextTerrain);
      if (e.nextElev !== null) this.map.setElevation(e.col, e.row, e.nextElev);
      this.chunks.markDirty(e.col, e.row);
    }
  }

  undo(): void {
    for (const e of this.edits) {
      this.map.setTerrain(e.col, e.row, e.prevTerrain);
      if (e.prevElev !== null) this.map.setElevation(e.col, e.row, e.prevElev);
      this.chunks.markDirty(e.col, e.row);
    }
  }
}

interface RiverEdit {
  col: number;
  row: number;
  prevIncoming: number; // -1 if none
  prevOutgoing: number; // -1 if none
}

export class RiverClearStrokeCommand implements Command {
  private map: HexMap;
  private chunks: ChunkManager;
  private edits: RiverEdit[];

  constructor(map: HexMap, chunks: ChunkManager, edits: RiverEdit[]) {
    this.map    = map;
    this.chunks = chunks;
    this.edits  = edits;
  }

  execute(): void {
    for (const e of this.edits) {
      this.map.clearRiver(e.col, e.row);
      this.chunks.markDirty(e.col, e.row);
    }
  }

  undo(): void {
    for (const e of this.edits) {
      this.map.clearRiver(e.col, e.row);
      if (e.prevIncoming >= 0) this.map.setRiverIncoming(e.col, e.row, e.prevIncoming);
      if (e.prevOutgoing >= 0) this.map.setRiverOutgoing(e.col, e.row, e.prevOutgoing);
      this.chunks.markDirty(e.col, e.row);
    }
  }
}
