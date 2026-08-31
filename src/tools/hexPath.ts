import { POINTY_TOP, offsetNeighbor } from '@loyalj/hex-world';
import type { HexCoord } from '@loyalj/hex-world';

/** Road/river edge i → hex direction EDGE_DIRS[i], in pointy-top order. */
export const EDGE_DIRS = POINTY_TOP.edgeDirections;

export function hexRound(fq: number, fr: number): HexCoord {
  const fs = -fq - fr;
  let q = Math.round(fq);
  let r = Math.round(fr);
  const s = Math.round(fs);
  const dq = Math.abs(q - fq);
  const dr = Math.abs(r - fr);
  const ds = Math.abs(s - fs);
  if (dq > dr && dq > ds) q = -r - s;
  else if (dr > ds) r = -q - s;
  return { q, r };
}

/** All cells on the straight hex line from `start` to `end`, inclusive. */
export function hexLineDraw(start: HexCoord, end: HexCoord): HexCoord[] {
  const n = Math.max(
    Math.abs(end.q - start.q),
    Math.abs(end.r - start.r),
    Math.abs((-end.q - end.r) - (-start.q - start.r)),
  );
  if (n === 0) return [start];
  const result: HexCoord[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    result.push(hexRound(
      start.q + (end.q - start.q) * t,
      start.r + (end.r - start.r) * t,
    ));
  }
  return result;
}

/** Cube distance between two hexes. */
export function hexDistance(a: HexCoord, b: HexCoord): number {
  return Math.max(
    Math.abs(a.q - b.q),
    Math.abs(a.r - b.r),
    Math.abs((-a.q - a.r) - (-b.q - b.r)),
  );
}

/** The edge index leading from one cell to an adjacent one, or null if not neighbours. */
export function edgeBetween(fromCol: number, fromRow: number, toCol: number, toRow: number): number | null {
  for (let i = 0; i < 6; i++) {
    const nb = offsetNeighbor(fromCol, fromRow, EDGE_DIRS[i]);
    if (nb.col === toCol && nb.row === toRow) return i;
  }
  return null;
}

/**
 * The connected region reachable from a start cell through edge neighbours
 * satisfying `matches`. Read-only traversal — callers decide what to do with
 * the region (flood-fill it, select it). The start cell is always included,
 * whether or not it matches.
 */
export function floodRegion(
  width: number, height: number,
  startCol: number, startRow: number,
  matches: (col: number, row: number) => boolean,
): Array<{ col: number; row: number }> {
  const visited = new Set<number>([startRow * width + startCol]);
  const region = [{ col: startCol, row: startRow }];
  let head = 0;
  while (head < region.length) {
    const { col, row } = region[head++];
    for (let dir = 0; dir < 6; dir++) {
      const nb = offsetNeighbor(col, row, EDGE_DIRS[dir]);
      if (nb.col < 0 || nb.col >= width || nb.row < 0 || nb.row >= height) continue;
      const key = nb.row * width + nb.col;
      if (visited.has(key)) continue;
      visited.add(key);
      if (matches(nb.col, nb.row)) region.push({ col: nb.col, row: nb.row });
    }
  }
  return region;
}
