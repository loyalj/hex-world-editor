import { findPath, hexToOffset } from '@loyalj/hex-world';
import type { HexCoord, HexMap, TerrainDefinition } from '@loyalj/hex-world';

/** Which cost signals the pathfinder weighs — the road panel's checkboxes. */
export interface PathCostOptions {
  elevation: boolean;
  terrain: boolean;
  roadBonus: boolean;
}

/**
 * The slice of the scene the path and river helpers read. SceneApi satisfies
 * this structurally; tests satisfy it with a bare HexMap and a water rule.
 */
export interface TerrainView {
  readonly map: HexMap;
  isWater(terrain: number): boolean;
  readonly terrainLookup: Map<number, TerrainDefinition>;
}

/**
 * Cost-weighted pathfinding shared by the road tool and the river tool's path
 * mode. `riverEnd` is the drag destination when routing a river: rivers may
 * end one cell INTO water (the land→water edge is what forms an estuary), so
 * that one cell costs 1 while all other water is impassable — paths never
 * route THROUGH water, and roads (riverEnd null) never enter it at all.
 */
export function computeCostPath(
  scene: TerrainView,
  startHex: HexCoord,
  endHex: HexCoord,
  opts: PathCostOptions,
  riverEnd: HexCoord | null,
): HexCoord[] | null {
  return findPath(
    startHex,
    endHex,
    (from, to) => {
      const toOff = hexToOffset(to);
      if (scene.isWater(scene.map.getTerrain(toOff.col, toOff.row))) {
        const isRiverEnd = riverEnd !== null && to.q === riverEnd.q && to.r === riverEnd.r;
        return isRiverEnd ? 1 : Infinity;
      }

      let cost = 1;

      if (opts.elevation) {
        const fromOff = hexToOffset(from);
        const diff = Math.abs(
          scene.map.getElevation(toOff.col, toOff.row) -
          scene.map.getElevation(fromOff.col, fromOff.row),
        );
        cost += diff * 1.5;
      }

      if (opts.terrain) {
        const def = scene.terrainLookup.get(scene.map.getTerrain(toOff.col, toOff.row));
        cost += (def?.roadCost ?? 1) - 1;
      }

      if (opts.roadBonus && scene.map.hasRoads(toOff.col, toOff.row)) {
        cost *= 0.25;
      }

      return cost;
    },
    scene.map,
    // The road bonus prices steps below 1, which would break the A* heuristic's
    // ≥1 assumption — without this, the pathfinder never discovers that a
    // longer route along an existing road is cheaper than cutting cross-country.
    { minMoveCost: opts.roadBonus ? 0.25 : 1 },
  );
}
