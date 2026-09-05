import { offsetNeighbor } from '@loyalj/hex-world';
import type { HexMap, MapTransaction } from '@loyalj/hex-world';
import { EDGE_DIRS } from './hexPath.ts';
import type { CellPos } from './tool.ts';

/**
 * Pure graph helpers over the map's river data. Rivers are stored on cells as
 * one outgoing edge plus a mask of incoming edges, so the map is a forest of
 * directed trees (tributaries merge, nothing splits). Everything here walks
 * that forest: whole systems, main stems, accumulated flow, where a river
 * ends up, drainage basins, and an audit of the ways hand-drawn rivers go
 * wrong. Nothing here writes except {@link reverseStem}, which takes the
 * transaction it should write through.
 */

export const cellKey = (map: { width: number }, col: number, row: number): number => row * map.width + col;

/** The cell a river cell drains into, or null at a terminus / map edge. */
export function downstreamOf(map: HexMap, col: number, row: number): CellPos | null {
  const out = map.getOutgoingRiverDir(col, row);
  if (out < 0) return null;
  const nb = offsetNeighbor(col, row, EDGE_DIRS[out]);
  return map.inBounds(nb.col, nb.row) ? nb : null;
}

/** The cells whose rivers flow into this one — the incoming edges with a matching neighbour. */
export function upstreamOf(map: HexMap, col: number, row: number): CellPos[] {
  const mask = map.getIncomingRiverMask(col, row);
  const cells: CellPos[] = [];
  for (let e = 0; e < 6; e++) {
    if (!(mask & (1 << e))) continue;
    const nb = offsetNeighbor(col, row, EDGE_DIRS[e]);
    if (!map.inBounds(nb.col, nb.row)) continue;
    if (map.getOutgoingRiverDir(nb.col, nb.row) === (e + 3) % 6) cells.push(nb);
  }
  return cells;
}

/**
 * Every cell connected to this one through river edges, upstream and down —
 * the whole system a tributary belongs to. Empty when the cell has no river.
 */
export function riverSystem(map: HexMap, col: number, row: number): CellPos[] {
  if (!map.hasRiver(col, row)) return [];
  const seen = new Set<number>([cellKey(map, col, row)]);
  const cells: CellPos[] = [{ col, row }];
  for (let head = 0; head < cells.length; head++) {
    const c = cells[head];
    const next = upstreamOf(map, c.col, c.row);
    const down = downstreamOf(map, c.col, c.row);
    if (down) next.push(down);
    for (const n of next) {
      const k = cellKey(map, n.col, n.row);
      if (seen.has(k)) continue;
      seen.add(k);
      cells.push(n);
    }
  }
  return cells;
}

/**
 * Accumulated flow per river cell: 1 for the cell itself plus everything
 * upstream. Keyed by {@link cellKey}. A cycle contributes its cells once.
 */
export function computeRiverFlow(map: HexMap): Map<number, number> {
  const flow = new Map<number, number>();
  const visiting = new Set<number>();
  const visit = (col: number, row: number): number => {
    const k = cellKey(map, col, row);
    const known = flow.get(k);
    if (known !== undefined) return known;
    if (visiting.has(k)) return 0; // cycle: don't count the loop twice
    visiting.add(k);
    let total = 1;
    for (const up of upstreamOf(map, col, row)) total += visit(up.col, up.row);
    visiting.delete(k);
    flow.set(k, total);
    return total;
  };
  for (let row = 0; row < map.height; row++) {
    for (let col = 0; col < map.width; col++) {
      if (map.hasRiver(col, row)) visit(col, row);
    }
  }
  return flow;
}

/**
 * The main stem through a cell, source to terminus: downstream to the end,
 * and upstream following the biggest tributary at every confluence. Ordered
 * source first. Stops short of repeating a cell, so a cycle yields the loop
 * once.
 */
export function riverStem(map: HexMap, col: number, row: number, flow = computeRiverFlow(map)): CellPos[] {
  if (!map.hasRiver(col, row)) return [];
  const seen = new Set<number>([cellKey(map, col, row)]);
  const up: CellPos[] = [];
  let cur: CellPos = { col, row };
  for (;;) {
    const ups = upstreamOf(map, cur.col, cur.row)
      .filter(c => !seen.has(cellKey(map, c.col, c.row)));
    if (ups.length === 0) break;
    cur = ups.reduce((best, c) =>
      (flow.get(cellKey(map, c.col, c.row)) ?? 0) > (flow.get(cellKey(map, best.col, best.row)) ?? 0) ? c : best);
    seen.add(cellKey(map, cur.col, cur.row));
    up.push(cur);
  }
  const down: CellPos[] = [];
  cur = { col, row };
  for (;;) {
    const next = downstreamOf(map, cur.col, cur.row);
    if (!next || seen.has(cellKey(map, next.col, next.row))) break;
    seen.add(cellKey(map, next.col, next.row));
    down.push(next);
    cur = next;
  }
  return [...up.reverse(), { col, row }, ...down];
}

export type RiverEndKind = 'water' | 'land' | 'cycle';

export interface RiverDestination extends CellPos {
  kind: RiverEndKind;
  /** Cells walked from the start to the end, the start included. */
  length: number;
}

/** Follow a river to where it ends: into water, at a land dead end, or round a loop. */
export function riverDestination(
  map: HexMap, isWater: (terrain: number) => boolean, col: number, row: number,
): RiverDestination | null {
  if (!map.hasRiver(col, row)) return null;
  const seen = new Set<number>([cellKey(map, col, row)]);
  let cur: CellPos = { col, row };
  let length = 1;
  for (;;) {
    if (isWater(map.getTerrain(cur.col, cur.row))) return { ...cur, kind: 'water', length };
    const next = downstreamOf(map, cur.col, cur.row);
    if (!next) return { ...cur, kind: 'land', length };
    if (seen.has(cellKey(map, next.col, next.row))) return { ...next, kind: 'cycle', length };
    seen.add(cellKey(map, next.col, next.row));
    cur = next;
    length++;
  }
}

/**
 * Drainage basins: every river cell keyed to the cell its water ends at, so
 * two rivers sharing a mouth share a basin. A loop's cells key to the first
 * loop cell reached.
 */
export function riverBasins(map: HexMap, isWater: (terrain: number) => boolean): Map<number, number> {
  const basin = new Map<number, number>();
  for (let row = 0; row < map.height; row++) {
    for (let col = 0; col < map.width; col++) {
      if (!map.hasRiver(col, row) || basin.has(cellKey(map, col, row))) continue;
      const trail: number[] = [];
      let cur: CellPos = { col, row };
      let end: number;
      for (;;) {
        const k = cellKey(map, cur.col, cur.row);
        const known = basin.get(k);
        if (known !== undefined) { end = known; break; }
        if (trail.includes(k)) { end = k; break; }
        trail.push(k);
        if (isWater(map.getTerrain(cur.col, cur.row))) { end = k; break; }
        const next = downstreamOf(map, cur.col, cur.row);
        if (!next) { end = k; break; }
        cur = next;
      }
      for (const k of trail) basin.set(k, end);
    }
  }
  return basin;
}

export type RiverIssueKind = 'uphill' | 'dead-end' | 'cycle' | 'low-source' | 'dangling';

export interface RiverIssue extends CellPos {
  kind: RiverIssueKind;
  /** One line for the audit list. */
  detail: string;
}

export const RIVER_ISSUE_LABELS: Record<RiverIssueKind, string> = {
  'uphill':     'Flows uphill',
  'dead-end':   'Ends on land',
  'cycle':      'Loops',
  'low-source': 'Low source',
  'dangling':   'Dangling edge',
};

/**
 * The ways a hand-drawn river network goes wrong. Uphill: a cell drains into
 * a higher one. Dead end: a terminus on land. Cycle: a cell whose downstream
 * walk comes back to it. Low source: a headwater below `minSourceElev`.
 * Dangling: a half-edge with no partner on the neighbour. One issue per cell
 * per kind, in map order.
 */
export function auditRivers(
  map: HexMap, isWater: (terrain: number) => boolean, minSourceElev: number,
): RiverIssue[] {
  const issues: RiverIssue[] = [];
  for (let row = 0; row < map.height; row++) {
    for (let col = 0; col < map.width; col++) {
      if (!map.hasRiver(col, row)) continue;
      const elev = map.getElevation(col, row);
      const out = map.getOutgoingRiverDir(col, row);
      const mask = map.getIncomingRiverMask(col, row);

      // Half-edges: an outgoing whose neighbour doesn't list us as incoming,
      // or an incoming bit whose neighbour doesn't flow our way.
      if (out >= 0) {
        const nb = offsetNeighbor(col, row, EDGE_DIRS[out]);
        if (!map.inBounds(nb.col, nb.row) || !map.hasRiverIncomingThroughEdge(nb.col, nb.row, (out + 3) % 6)) {
          issues.push({ col, row, kind: 'dangling', detail: 'outgoing edge with no downstream partner' });
        } else if (map.getElevation(nb.col, nb.row) > elev && !isWater(map.getTerrain(col, row))) {
          issues.push({ col, row, kind: 'uphill', detail: `${elev} → ${map.getElevation(nb.col, nb.row)}` });
        }
      }
      for (let e = 0; e < 6; e++) {
        if (!(mask & (1 << e))) continue;
        const nb = offsetNeighbor(col, row, EDGE_DIRS[e]);
        if (!map.inBounds(nb.col, nb.row) || map.getOutgoingRiverDir(nb.col, nb.row) !== (e + 3) % 6) {
          issues.push({ col, row, kind: 'dangling', detail: 'incoming edge with no upstream partner' });
          break;
        }
      }

      const isSource = mask === 0 && out >= 0;
      if (isSource && elev < minSourceElev && !isWater(map.getTerrain(col, row))) {
        issues.push({ col, row, kind: 'low-source', detail: `source at elevation ${elev}` });
      }
      if (out < 0 && !isWater(map.getTerrain(col, row))) {
        issues.push({ col, row, kind: 'dead-end', detail: `terminus at elevation ${elev}` });
      }
      const dest = riverDestination(map, isWater, col, row);
      if (dest?.kind === 'cycle' && dest.col === col && dest.row === row) {
        issues.push({ col, row, kind: 'cycle', detail: `loop of ${dest.length} cells` });
      }
    }
  }
  return issues;
}

/**
 * Turn a stem around: every edge along it flows the other way, so the old
 * terminus becomes the source. Tributaries joining the stem keep their
 * incoming edges — they still flow into it. The mask and locks bound it:
 * reversal runs from the terminus back to the first protected cell and stops
 * there, since the cell just downstream of a protected one would otherwise
 * need two outgoing edges. Returns how many edges flipped.
 */
export function reverseStem(
  tx: MapTransaction, map: HexMap, stem: CellPos[],
  allowed: (col: number, row: number) => boolean,
  markDirty: (col: number, row: number) => void,
): number {
  // The trailing run of allowed pairs, terminus back toward the source.
  const pairs: Array<{ a: CellPos; b: CellPos; edge: number }> = [];
  for (let i = stem.length - 2; i >= 0; i--) {
    const a = stem[i], b = stem[i + 1];
    if (!allowed(a.col, a.row) || !allowed(b.col, b.row)) break;
    const edge = map.getOutgoingRiverDir(a.col, a.row);
    if (edge < 0) break;
    const nb = offsetNeighbor(a.col, a.row, EDGE_DIRS[edge]);
    if (nb.col !== b.col || nb.row !== b.row) break;
    pairs.push({ a, b, edge });
  }
  for (const { a, b, edge } of pairs) {
    tx.removeRiverOutgoing(a.col, a.row);
    tx.removeRiverIncoming(b.col, b.row, (edge + 3) % 6);
  }
  for (const { a, b, edge } of pairs) {
    tx.setRiverOutgoing(b.col, b.row, (edge + 3) % 6);
    tx.setRiverIncoming(a.col, a.row, edge);
    markDirty(a.col, a.row);
    markDirty(b.col, b.row);
  }
  return pairs.length;
}
