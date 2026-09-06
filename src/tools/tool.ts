import type { MapEdit } from '@loyalj/hex-world';
import type { SceneApi } from '../scene.ts';

export type ToolId =
  | 'select'
  | 'paint-terrain' | 'elevation' | 'paint-river' | 'paint-road' | 'paint-scatter'
  | 'environment' | 'paint-territory' | 'paint-resource' | 'paint-fog' | 'paint-unit';

export interface CellPos { col: number; row: number }

/**
 * What every tool gets to work with. One instance is shared by all tools;
 * `syncBrushRadius` and `updateCursor` are stubs until the tool manager wires
 * them, so tools may call them freely from their constructors.
 */
export interface ToolContext {
  scene: SceneApi;
  /** Push a finished MapEdit into the undo history (no-op for empty edits). */
  commitEdit(edit: MapEdit): void;
  /**
   * Repaint the minimap after a mutation that hasn't reached the history yet.
   * With `cells`, only the pixels under those cells; without, the whole map.
   */
  minimapInvalidate(cells?: Iterable<CellPos>): void;
  /** Push the active tool's brush radius into the scene's hover footprint. */
  syncBrushRadius(): void;
  /** Re-evaluate the viewport cursor (fill mode, etc.). */
  updateCursor(): void;
  /**
   * Saved-file state OUTSIDE the undo history changed — fog exploration,
   * environment settings. Marks the document unsaved and schedules an
   * autosave. Assigned by the app once persistence exists; a stub until then.
   */
  noteSettingsChanged(): void;
}

/**
 * One editor tool: its identity for the rail/drawer, its pointer behaviour on
 * the map, and its line in the status strip. Each tool also owns wiring its
 * own options panel — the manager only shows and hides the panel element.
 */
export interface Tool {
  readonly id: ToolId;
  /** Drawer header title. */
  readonly title: string;
  /** The tool's options panel in the left drawer. */
  readonly panel: HTMLElement;
  /** Whether Alt+click samples the map — drives the eyedropper cursor. */
  readonly hasEyedropper?: boolean;
  /**
   * True for tools whose clicks aren't confined by the selection mask (the
   * selection tool itself, tools that edit no cells). Everything else gets
   * out-of-mask feedback on the hover footprint while a selection is active.
   */
  readonly ignoresSelectionMask?: boolean;
  /**
   * True for tools the terrain locks don't apply to — those editing per-player
   * or view state rather than map content (fog), and those that edit no cells
   * at all. Suppresses the locked-cell tint on the hover footprint.
   */
  readonly ignoresLocks?: boolean;

  /** Hover-footprint radius (0 = single cell). */
  brushRadius(): number;
  /**
   * The exact hover footprint for tools whose stamp isn't the filled hex of
   * {@link brushRadius} (rings, sprays). Absent, the scene draws the hex.
   */
  hoverFootprint?(cell: CellPos): CellPos[];
  /** The tool just became the active one — refresh anything that went stale while it was hidden. */
  activate?(): void;
  /** Reset transient state (previews, part-done gestures) when switched away. */
  deactivate(): void;

  /** Left-button press on a map cell. */
  pointerDown(cell: CellPos, e: PointerEvent): void;
  /**
   * A stationary right click on a cell. A right-drag is the camera's rotate
   * gesture, so the manager resolves the click at release; tools without
   * this get no right-click behaviour at all.
   */
  rightClick?(cell: CellPos, e: PointerEvent): void;
  pointerMove(cell: CellPos | null, e: PointerEvent): void;
  pointerUp(): void;
  doubleClick?(): void;
  /** Handle a keydown (focus not in a text field). Return true when consumed. */
  keyDown?(e: KeyboardEvent): boolean;

  /** Whether the viewport should show the fill (bucket) cursor right now. */
  wantsFillCursor?(): boolean;
  /** Status-strip text: what the tool will do on the next click. */
  statusText(): string;
}

/** Cells covered by a hex brush of the given radius: 1, 7, 19, 37… */
export const brushCells = (r: number): number => 3 * r * r + 3 * r + 1;

/**
 * Wipe one metadata key across the whole map as one undoable edit. Ownership
 * and resources both live in the metadata channel, so the transaction has to
 * touch every cell it clears for the snapshot to be able to put it back.
 * Honours the selection mask and the terrain locks: with a selection active,
 * "all" means all selected cells, and protected cells keep their data.
 */
export function clearMetadataKey(
  ctx: ToolContext,
  key: string,
  matches: (col: number, row: number) => boolean,
): void {
  const { map } = ctx.scene;
  const tx = map.beginEdit();
  let count = 0;
  for (let row = 0; row < map.height; row++) {
    for (let col = 0; col < map.width; col++) {
      if (!matches(col, row) || !ctx.scene.editable(col, row)) continue;
      tx.setCellData(col, row, key, undefined);
      count++;
    }
  }
  if (count === 0) return;
  ctx.commitEdit(tx.commit());
  ctx.scene.refreshGameplayLayers();
}
