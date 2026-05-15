import type { HexMap, ChunkManager } from '@loyalj/hex-world';
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

interface RiverPaintEdit {
  col: number;
  row: number;
  prevIncoming: number; // -1 if none
  prevOutgoing: number; // -1 if none
  nextIncoming: number; // -1 = clear
  nextOutgoing: number; // -1 = clear
}

interface RoadEdge {
  col: number; row: number; edge: number;
  nCol: number; nRow: number; nEdge: number;
  prevSet: boolean;   // road was already present on this cell's edge before stroke
  prevNSet: boolean;  // road was already present on neighbour's edge before stroke
}

export class RoadPaintStrokeCommand implements Command {
  private map: HexMap;
  private chunks: ChunkManager;
  private edits: RoadEdge[];
  private state: boolean;

  constructor(map: HexMap, chunks: ChunkManager, edits: RoadEdge[], state = true) {
    this.map    = map;
    this.chunks = chunks;
    this.edits  = edits;
    this.state  = state;
  }

  execute(): void {
    for (const e of this.edits) {
      this.map.setRoad(e.col,  e.row,  e.edge,  this.state);
      this.map.setRoad(e.nCol, e.nRow, e.nEdge, this.state);
      this.chunks.markDirty(e.col,  e.row);
      this.chunks.markDirty(e.nCol, e.nRow);
    }
  }

  undo(): void {
    for (const e of this.edits) {
      this.map.setRoad(e.col,  e.row,  e.edge,  e.prevSet);
      this.map.setRoad(e.nCol, e.nRow, e.nEdge, e.prevNSet);
      this.chunks.markDirty(e.col,  e.row);
      this.chunks.markDirty(e.nCol, e.nRow);
    }
  }
}

interface ScatterEdit {
  col: number;
  row: number;
  layer: number;
  prev: number;
  next: number;
}

export class ScatterPaintStrokeCommand implements Command {
  private map: HexMap;
  private chunks: ChunkManager;
  private edits: ScatterEdit[];

  constructor(map: HexMap, chunks: ChunkManager, edits: ScatterEdit[]) {
    this.map    = map;
    this.chunks = chunks;
    this.edits  = edits;
  }

  execute(): void {
    for (const e of this.edits) {
      this.map.setFeatureLevel(e.col, e.row, e.layer, e.next);
      this.chunks.markDirty(e.col, e.row);
    }
  }

  undo(): void {
    for (const e of this.edits) {
      this.map.setFeatureLevel(e.col, e.row, e.layer, e.prev);
      this.chunks.markDirty(e.col, e.row);
    }
  }
}

export class RiverPaintStrokeCommand implements Command {
  private map: HexMap;
  private chunks: ChunkManager;
  private edits: RiverPaintEdit[];

  constructor(map: HexMap, chunks: ChunkManager, edits: RiverPaintEdit[]) {
    this.map    = map;
    this.chunks = chunks;
    this.edits  = edits;
  }

  execute(): void {
    for (const e of this.edits) {
      this.map.clearRiver(e.col, e.row);
      if (e.nextIncoming >= 0) this.map.setRiverIncoming(e.col, e.row, e.nextIncoming);
      if (e.nextOutgoing >= 0) this.map.setRiverOutgoing(e.col, e.row, e.nextOutgoing);
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
