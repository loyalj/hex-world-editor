/**
 * The editor's built-in unit type set and the metadata contract for placed
 * units. Units live in the map's sparse metadata channel like ownership and
 * resources do, so they ride through undo, save/load, and `.hexpack` without
 * any extra persistence: one {@link PlacedUnit} record per occupied cell,
 * under {@link UNIT_KEY}.
 */
export interface UnitTypeDescriptor {
  id: string;
  name: string;
  /** Palette chip colour — placed markers are tinted by faction, not type. */
  color: number;
  /** Naval units place only on water; everything else only on land. */
  naval: boolean;
}

/** Metadata key a cell's unit is stored under. */
export const UNIT_KEY = 'unit';

/** What a cell's {@link UNIT_KEY} metadata entry holds. */
export interface PlacedUnit {
  type: string;
  faction: string;
}

export const UNIT_TYPES: UnitTypeDescriptor[] = [
  { id: 'infantry', name: 'Infantry', color: 0x8899aa, naval: false },
  { id: 'cavalry',  name: 'Cavalry',  color: 0xb08a5a, naval: false },
  { id: 'archer',   name: 'Archer',   color: 0x7aa86a, naval: false },
  { id: 'ship',     name: 'Ship',     color: 0x5a87b0, naval: true  },
];

/** The unit stored on a cell, or null — validates the metadata shape. */
export function unitAt(
  map: { getCellData(col: number, row: number, key: string): unknown },
  col: number, row: number,
): PlacedUnit | null {
  const v = map.getCellData(col, row, UNIT_KEY) as PlacedUnit | undefined;
  return v && typeof v.type === 'string' && typeof v.faction === 'string' ? v : null;
}
