import { offsetNeighbor } from '@loyalj/hex-world';
import type { HexMap } from '@loyalj/hex-world';
import { EDGE_DIRS } from './hexPath.ts';
import { cellKey } from './riverGraph.ts';

/**
 * Pure graph helpers over the map's road data. Roads are stored per cell as a
 * mask of half-edges, and the paired write in `setRoadEdge` keeps the two
 * halves of a shared edge in agreement, so the map is an undirected graph of
 * cells joined wherever both sides carry the half-edge. Nothing here writes.
 */

/** Whether a road crosses the given edge with the neighbour agreeing — a lone half-edge doesn't join anything. */
export function roadCrossesEdge(map: HexMap, col: number, row: number, edge: number): boolean {
  if (!map.hasRoadThroughEdge(col, row, edge)) return false;
  const nb = offsetNeighbor(col, row, EDGE_DIRS[edge]);
  return map.inBounds(nb.col, nb.row) && map.hasRoadThroughEdge(nb.col, nb.row, (edge + 3) % 6);
}

/** The road cells joined to this one by a paired road edge. */
export function roadNeighborsOf(map: HexMap, col: number, row: number): Array<{ col: number; row: number }> {
  const cells: Array<{ col: number; row: number }> = [];
  for (let e = 0; e < 6; e++) {
    if (roadCrossesEdge(map, col, row, e)) cells.push(offsetNeighbor(col, row, EDGE_DIRS[e]));
  }
  return cells;
}

/**
 * Road networks: every road cell keyed to the lowest-keyed cell of the
 * connected network it belongs to, so two cells share a value exactly when a
 * road joins them. A cell whose only road edges point off-map or at a
 * neighbour without the matching half is a network of one.
 */
export function roadNetworks(map: HexMap): Map<number, number> {
  const network = new Map<number, number>();
  for (let row = 0; row < map.height; row++) {
    for (let col = 0; col < map.width; col++) {
      const start = cellKey(map, col, row);
      if (!map.hasRoads(col, row) || network.has(start)) continue;
      // Row-major scan means the first cell reached is the lowest key of its
      // network, so it doubles as the network's id.
      const queue: Array<{ col: number; row: number }> = [{ col, row }];
      network.set(start, start);
      for (let head = 0; head < queue.length; head++) {
        const c = queue[head];
        for (const n of roadNeighborsOf(map, c.col, c.row)) {
          const k = cellKey(map, n.col, n.row);
          if (network.has(k)) continue;
          network.set(k, start);
          queue.push(n);
        }
      }
    }
  }
  return network;
}

/**
 * Every cell joined to this one through paired road edges — the whole
 * network it belongs to, in walk order. Empty when the cell has no road.
 */
export function roadNetworkOf(map: HexMap, col: number, row: number): Array<{ col: number; row: number }> {
  if (!map.hasRoads(col, row)) return [];
  const seen = new Set<number>([cellKey(map, col, row)]);
  const cells: Array<{ col: number; row: number }> = [{ col, row }];
  for (let head = 0; head < cells.length; head++) {
    const c = cells[head];
    for (const n of roadNeighborsOf(map, c.col, c.row)) {
      const k = cellKey(map, n.col, n.row);
      if (seen.has(k)) continue;
      seen.add(k);
      cells.push(n);
    }
  }
  return cells;
}

/** Paired road edges on a cell — a terminus has one, a junction three or more. */
export function roadDegree(map: HexMap, col: number, row: number): number {
  let n = 0;
  for (let e = 0; e < 6; e++) if (roadCrossesEdge(map, col, row, e)) n++;
  return n;
}

export type RoadIssueKind = 'dangling' | 'water' | 'cliff' | 'spur' | 'fragment';

export interface RoadIssue {
  col: number;
  row: number;
  kind: RoadIssueKind;
  /** One line for the audit list. */
  detail: string;
}

export const ROAD_ISSUE_LABELS: Record<RoadIssueKind, string> = {
  'dangling': 'Dangling edge',
  'water':    'Crosses water',
  'cliff':    'Crosses a cliff',
  'spur':     'Short spur',
  'fragment': 'Isolated fragment',
};

/** Two cells whose elevations differ by this much meet at a cliff face, not a slope. */
const CLIFF_STEP = 2;

/**
 * The ways a hand-drawn road network goes wrong. Dangling: a half-edge the
 * neighbour doesn't answer, or one that leads off the map. Water: a road on
 * a liquid cell — the pathfinder never routes there, so one only arrives by
 * hand. Cliff: a paired edge between cells too far apart in height to be a
 * slope, reported once on the lower-keyed cell. Spur: a terminus whose branch
 * reaches a junction in fewer than `shortLength` cells — an accidental stub.
 * Fragment: a network of fewer than `shortLength` cells, reported once on its
 * lowest cell. One issue per cell per kind, in map order.
 */
export function auditRoads(
  map: HexMap, isWater: (terrain: number) => boolean, shortLength: number,
): RoadIssue[] {
  const issues: RoadIssue[] = [];
  const networks = roadNetworks(map);
  const sizes = new Map<number, number>();
  for (const id of networks.values()) sizes.set(id, (sizes.get(id) ?? 0) + 1);

  for (let row = 0; row < map.height; row++) {
    for (let col = 0; col < map.width; col++) {
      if (!map.hasRoads(col, row)) continue;
      const key = cellKey(map, col, row);
      const elev = map.getElevation(col, row);

      let dangling: string | null = null;
      let cliff: string | null = null;
      for (let e = 0; e < 6; e++) {
        if (!map.hasRoadThroughEdge(col, row, e)) continue;
        const nb = offsetNeighbor(col, row, EDGE_DIRS[e]);
        if (!map.inBounds(nb.col, nb.row)) {
          dangling ??= 'edge leads off the map';
        } else if (!map.hasRoadThroughEdge(nb.col, nb.row, (e + 3) % 6)) {
          dangling ??= `edge toward ${nb.col}, ${nb.row} has no partner`;
        } else if (cellKey(map, nb.col, nb.row) > key) {
          const nbElev = map.getElevation(nb.col, nb.row);
          if (Math.abs(nbElev - elev) >= CLIFF_STEP) cliff ??= `${elev} → ${nbElev} toward ${nb.col}, ${nb.row}`;
        }
      }
      if (dangling) issues.push({ col, row, kind: 'dangling', detail: dangling });
      if (isWater(map.getTerrain(col, row))) issues.push({ col, row, kind: 'water', detail: 'road on a liquid cell' });
      if (cliff) issues.push({ col, row, kind: 'cliff', detail: cliff });

      if (roadDegree(map, col, row) === 1) {
        const spur = spurOf(map, col, row, shortLength);
        if (spur) {
          issues.push({
            col, row, kind: 'spur',
            detail: `${spur.length} cell${spur.length === 1 ? '' : 's'} off the junction at ${spur.junction.col}, ${spur.junction.row}`,
          });
        }
      }

      const size = sizes.get(key);
      if (size !== undefined && networks.get(key) === key && size < shortLength) {
        issues.push({ col, row, kind: 'fragment', detail: `network of ${size} cell${size === 1 ? '' : 's'}` });
      }
    }
  }
  return issues;
}

/**
 * Walk from a terminus along its branch. A junction (three or more paired
 * edges) within `shortLength` cells makes the branch a spur: the number of
 * cells before the junction, and where it is. Null when the branch is long
 * enough, or runs out at another terminus — a whole road is not a stub.
 */
function spurOf(
  map: HexMap, col: number, row: number, shortLength: number,
): { length: number; junction: { col: number; row: number } } | null {
  let prev = { col, row };
  let cur = roadNeighborsOf(map, col, row)[0]; // a terminus has exactly one
  for (let length = 1; length < shortLength; length++) {
    const degree = roadDegree(map, cur.col, cur.row);
    if (degree >= 3) return { length, junction: cur };
    if (degree === 1) return null;
    const next = roadNeighborsOf(map, cur.col, cur.row).find(n => n.col !== prev.col || n.row !== prev.row)!;
    prev = cur;
    cur = next;
  }
  return null;
}
