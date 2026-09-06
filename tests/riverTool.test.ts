// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest';
import type { MapEdit } from '@loyalj/hex-world';
import { RiverTool } from '../src/tools/riverTool.ts';
import { clickOption, countCells, loadEditorDom, makeCtx, makeScene, pev, setInput, WATER } from './helpers.ts';
import { downstreamOf } from '../src/tools/riverGraph.ts';
import { hexToOffset, offsetNeighbor } from '@loyalj/hex-world';
import { EDGE_DIRS } from '../src/tools/hexPath.ts';
import type { FakeScene } from './helpers.ts';

let s: FakeScene;
let tool: RiverTool;
let edits: MapEdit[];

beforeEach(() => {
  loadEditorDom();
  s = makeScene();
  const made = makeCtx(s);
  edits = made.edits;
  tool = new RiverTool(made.ctx, () => ({ elevation: false, terrain: false, roadBonus: false }));
});

/** Drag from a to b in the current mode. */
function drag(a: [number, number], b: [number, number], shiftKey = false): void {
  tool.pointerDown({ col: a[0], row: a[1] }, pev({ shiftKey }));
  s.hoveredCell = { col: b[0], row: b[1] };
  tool.pointerMove({ col: b[0], row: b[1] }, pev({ shiftKey }));
  tool.pointerUp();
  s.hoveredCell = null;
}

describe('RiverTool', () => {
  it('a straight drag lays a connected river', () => {
    clickOption('#river-mode-group .brush-btn[data-river-mode="straight"]');
    drag([2, 4], [6, 4]);

    for (let c = 2; c <= 6; c++) expect(s.map.hasRiver(c, 4)).toBe(true);
    // Upstream cells flow onward; the endpoint is a terminus.
    for (let c = 2; c <= 5; c++) expect(s.map.getOutgoingRiverDir(c, 4)).toBeGreaterThanOrEqual(0);
    expect(s.map.getOutgoingRiverDir(6, 4)).toBeLessThan(0);
    expect(edits.length).toBe(1);
  });

  it('a path-mode drag also reaches the target on open ground', () => {
    drag([2, 4], [6, 4]); // default mode is 'path'
    expect(s.map.hasRiver(2, 4)).toBe(true);
    expect(s.map.hasRiver(6, 4)).toBe(true);
  });

  it('stops at the shoreline, keeping one estuary cell', () => {
    s.map.setTerrain(5, 4, WATER);
    s.map.setTerrain(6, 4, WATER);
    clickOption('#river-mode-group .brush-btn[data-river-mode="straight"]');
    drag([2, 4], [6, 4]);

    expect(s.map.hasRiver(4, 4)).toBe(true);
    expect(s.map.hasRiver(5, 4)).toBe(true);  // the estuary edge lands here
    expect(s.map.hasRiver(6, 4)).toBe(false); // open water stays clean
  });

  it('Shift over the same line erases it', () => {
    clickOption('#river-mode-group .brush-btn[data-river-mode="straight"]');
    drag([2, 4], [6, 4]);
    drag([2, 4], [6, 4], true);
    for (let c = 2; c <= 6; c++) expect(s.map.hasRiver(c, 4)).toBe(false);
  });

  it('the erase brush clears a cell and detaches its neighbours', () => {
    clickOption('#river-mode-group .brush-btn[data-river-mode="straight"]');
    drag([2, 4], [6, 4]);
    clickOption('#river-mode-group .brush-btn[data-river-mode="erase"]');
    tool.pointerDown({ col: 4, row: 4 }, pev());
    tool.pointerUp();

    expect(s.map.hasRiver(4, 4)).toBe(false);
    expect(s.map.getOutgoingRiverDir(3, 4)).toBeLessThan(0); // upstream no longer flows into the gap
    expect(s.map.hasRiver(5, 4)).toBe(true);                 // downstream keeps its own outgoing
    expect(edits.length).toBe(2); // the draw and the erase stroke
  });

  it('downhill mode traces a gradient into water', () => {
    for (let row = 0; row < s.map.height; row++) {
      for (let col = 0; col < s.map.width; col++) s.map.setElevation(col, row, 9);
    }
    [5, 4, 3, 2, 1].forEach((elev, i) => s.map.setElevation(2 + i, 5, elev));
    s.map.setTerrain(7, 5, WATER);
    s.map.setElevation(7, 5, -1);

    clickOption('#river-mode-group .brush-btn[data-river-mode="downhill"]');
    tool.pointerDown({ col: 2, row: 5 }, pev());
    tool.pointerUp();

    expect(s.map.hasRiver(2, 5)).toBe(true);
    expect(s.map.hasRiver(6, 5)).toBe(true);
    expect(edits.length).toBe(1);
  });

  it('waypoints commit on double-click', () => {
    clickOption('#river-mode-group .brush-btn[data-river-mode="waypoint"]');
    tool.pointerDown({ col: 2, row: 2 }, pev());
    tool.pointerDown({ col: 6, row: 2 }, pev());
    tool.doubleClick!();

    expect(s.map.hasRiver(2, 2)).toBe(true);
    expect(s.map.hasRiver(6, 2)).toBe(true);
    expect(edits.length).toBe(1);
  });

  it('Escape abandons a waypoint river', () => {
    clickOption('#river-mode-group .brush-btn[data-river-mode="waypoint"]');
    tool.pointerDown({ col: 2, row: 2 }, pev());
    tool.pointerDown({ col: 6, row: 2 }, pev());
    expect(tool.keyDown!(new KeyboardEvent('keydown', { key: 'Escape' }))).toBe(true);
    tool.doubleClick!(); // nothing pending any more
    expect(edits.length).toBe(0);
    expect(s.map.hasRiver(2, 2)).toBe(false);
  });

  it('confluences merge instead of overwriting', () => {
    clickOption('#river-mode-group .brush-btn[data-river-mode="straight"]');
    drag([2, 4], [6, 4]);      // main stem
    drag([4, 1], [4, 4]);      // tributary joining mid-stem
    // The joint cell carries both incomings and one outgoing.
    expect(s.map.hasRiver(4, 4)).toBe(true);
    expect(s.map.getOutgoingRiverDir(4, 4)).toBeGreaterThanOrEqual(0);
    expect(s.map.getIncomingRiverMask(4, 4)).not.toBe(0);
    // Upstream of both branches still flows.
    expect(s.map.getOutgoingRiverDir(3, 4)).toBeGreaterThanOrEqual(0);
    expect(s.map.hasRiver(4, 1)).toBe(true);
  });
});

describe('whole-river actions', () => {
  const mode = (m: string) => clickOption(`#river-mode-group .brush-btn[data-river-mode="${m}"]`);
  const river = () => countCells(s.map, (c, r) => s.map.hasRiver(c, r));
  /** Two straight rivers: row 4 from 2→6 and row 8 from 1→3. */
  const twoRivers = () => {
    mode('straight');
    drag([2, 4], [6, 4]);
    drag([1, 8], [3, 8]);
    edits.length = 0;
  };

  it('Alt+click selects the whole river; Shift+Alt adds another', () => {
    twoRivers();
    tool.pointerDown({ col: 4, row: 4 }, pev({ altKey: true }));
    tool.pointerUp();
    expect(s.selection.size).toBe(5);
    expect(s.selection.has(2, 4)).toBe(true);
    tool.pointerDown({ col: 2, row: 8 }, pev({ altKey: true, shiftKey: true }));
    tool.pointerUp();
    expect(s.selection.size).toBe(8);
    expect(edits.length).toBe(0); // selection only, no map edit
  });

  it('Alt hover previews the system and the status says how many cells', () => {
    twoRivers();
    tool.pointerMove({ col: 4, row: 4 }, pev({ altKey: true }));
    expect(s.selectionPreviews.at(-1)).toHaveLength(5);
    expect(tool.statusText()).toContain('selects 5 river cells');
    tool.pointerMove({ col: 4, row: 4 }, pev());
    expect(s.selectionPreviews.at(-1)).toBeNull();
  });

  it('erase in whole-river scope removes one system and leaves the other', () => {
    twoRivers();
    mode('erase');
    clickOption('#river-erase-scope-group .scatter-type-btn[data-erase-scope="river"]');
    expect(tool.statusText()).toContain('whole river');
    tool.pointerDown({ col: 4, row: 4 }, pev());
    tool.pointerUp();
    expect(river()).toBe(3);
    expect(s.map.hasRiver(2, 8)).toBe(true);
    expect(edits.length).toBe(1);
  });

  it('the erase scope control shows only in erase mode', () => {
    const group = document.getElementById('river-erase-scope-group')!;
    expect(group.classList.contains('hidden')).toBe(true);
    mode('erase');
    expect(group.classList.contains('hidden')).toBe(false);
    mode('straight');
    expect(group.classList.contains('hidden')).toBe(true);
  });

  it('reverse mode previews the stem and flips it on click', () => {
    twoRivers();
    mode('reverse');
    tool.pointerMove({ col: 4, row: 4 }, pev());
    expect(s.previews.at(-1)).toHaveLength(5);
    expect(tool.statusText()).toContain('stem of 5 cells');
    tool.pointerDown({ col: 4, row: 4 }, pev());
    tool.pointerUp();
    expect(downstreamOf(s.map, 6, 4)).toEqual({ col: 5, row: 4 });
    expect(downstreamOf(s.map, 2, 4)).toBeNull();
    expect(edits.length).toBe(1);
    edits[0].undo();
    expect(downstreamOf(s.map, 2, 4)).toEqual({ col: 3, row: 4 });
  });

  it('clear rivers empties the selection, or the map with none', () => {
    twoRivers();
    s.selection.setCells([{ col: 2, row: 8 }, { col: 3, row: 8 }, { col: 1, row: 8 }]);
    (document.getElementById('river-clear-btn') as HTMLButtonElement).click();
    expect(s.map.hasRiver(2, 8)).toBe(false);
    expect(river()).toBe(5);
    s.selection.clear();
    (document.getElementById('river-clear-btn') as HTMLButtonElement).click();
    expect(river()).toBe(0);
    expect(edits.length).toBe(2);
  });
});

describe('downhill trace preview and lakes', () => {
  const mode = (m: string) => clickOption(`#river-mode-group .brush-btn[data-river-mode="${m}"]`);
  const setLake = (on: boolean) => {
    const el = document.getElementById('river-lake-at-sinks') as HTMLInputElement;
    el.checked = on;
    el.dispatchEvent(new Event('change', { bubbles: true }));
  };
  /** A slope down row 4 from col 2 into a hollow at col 6 with no water anywhere. */
  const hollow = () => {
    for (let c = 0; c < 12; c++) for (let r = 0; r < 12; r++) s.map.setElevation(c, r, 9);
    for (let c = 2; c <= 6; c++) s.map.setElevation(c, 4, 8 - c);
    s.map.setElevation(7, 4, 2); // a second floor cell at the sink's level
  };

  it('hovering previews the trace before the click', () => {
    hollow();
    s.map.setTerrain(6, 4, WATER);
    mode('downhill');
    tool.pointerMove({ col: 2, row: 4 }, pev());
    expect(s.previews.at(-1)).toHaveLength(5);
    expect(tool.statusText()).toContain('5 cells · reaches water');
    tool.pointerMove(null, pev());
    expect(s.previews.at(-1)).toBeNull();
  });

  it('a dead-end trace reports so, and with the option on previews the lake', () => {
    hollow();
    mode('downhill');
    tool.pointerMove({ col: 2, row: 4 }, pev());
    expect(tool.statusText()).toMatch(/dead end$/);
    setLake(true);
    expect(tool.statusText()).toContain('dead end · lake of 2');
    expect(s.selectionPreviews.at(-1)).toHaveLength(2);
  });

  it('the click turns the hollow into a lake the river ends in', () => {
    hollow();
    mode('downhill');
    setLake(true);
    tool.pointerDown({ col: 2, row: 4 }, pev());
    tool.pointerUp();
    expect(s.map.getTerrain(6, 4)).toBe(WATER);
    expect(s.map.getTerrain(7, 4)).toBe(WATER);
    expect(s.map.hasRiver(5, 4)).toBe(true);
    expect(edits.length).toBe(1);
    edits[0].undo();
    expect(s.map.getTerrain(6, 4)).toBe(0);
    expect(s.map.hasRiver(5, 4)).toBe(false);
  });

  it('with the option off a dead-end trace stays a plain river', () => {
    hollow();
    mode('downhill');
    tool.pointerDown({ col: 2, row: 4 }, pev());
    tool.pointerUp();
    expect(s.map.getTerrain(6, 4)).toBe(0);
    expect(s.map.hasRiver(6, 4)).toBe(true);
  });

  it('the lake option shows in every drawing mode but not reverse or erase', () => {
    const row = document.getElementById('river-lake-row')!;
    // Visible on a fresh load too, before any mode click: path is the default.
    expect(row.classList.contains('hidden')).toBe(false);
    for (const m of ['path', 'straight', 'waypoint', 'downhill']) {
      mode(m);
      expect(row.classList.contains('hidden'), m).toBe(false);
    }
    for (const m of ['reverse', 'erase']) {
      mode(m);
      expect(row.classList.contains('hidden'), m).toBe(true);
    }
  });
});

describe('lakes at the end of drawn rivers', () => {
  const mode = (m: string) => clickOption(`#river-mode-group .brush-btn[data-river-mode="${m}"]`);
  const setLake = (on: boolean) => {
    const el = document.getElementById('river-lake-at-sinks') as HTMLInputElement;
    el.checked = on;
    el.dispatchEvent(new Event('change', { bubbles: true }));
  };
  /** Row 4 slopes down from col 2 to a two-cell floor at cols 6–7; everything else is high. */
  const hollow = () => {
    for (let c = 0; c < 12; c++) for (let r = 0; r < 12; r++) s.map.setElevation(c, r, 9);
    for (let c = 2; c <= 6; c++) s.map.setElevation(c, 4, 8 - c);
    s.map.setElevation(7, 4, 2);
  };

  it('a straight drag previews the lake while dragging and lays it on release', () => {
    hollow();
    mode('straight');
    setLake(true);
    tool.pointerDown({ col: 2, row: 4 }, pev());
    s.hoveredCell = { col: 6, row: 4 };
    tool.pointerMove({ col: 6, row: 4 }, pev());
    expect(s.selectionPreviews.at(-1)).toHaveLength(2);
    expect(tool.statusText()).toContain('ends on land · lake of 2');
    tool.pointerUp();
    s.hoveredCell = null;

    expect(s.selectionPreviews.at(-1)).toBeNull();
    expect(s.map.getTerrain(6, 4)).toBe(WATER);
    expect(s.map.getTerrain(7, 4)).toBe(WATER);
    expect(s.map.hasRiver(5, 4)).toBe(true);
    expect(edits.length).toBe(1);
    edits[0].undo();
    expect(s.map.getTerrain(6, 4)).toBe(0);
  });

  it('a path-mode drag leaves a lake too', () => {
    hollow();
    setLake(true); // default mode is 'path'
    drag([2, 4], [6, 4]);
    expect(s.map.getTerrain(6, 4)).toBe(WATER);
    expect(s.map.hasRiver(5, 4)).toBe(true);
  });

  it('Shift-erasing along a line never makes a lake', () => {
    hollow();
    mode('straight');
    setLake(true);
    drag([2, 4], [6, 4], true);
    expect(s.map.getTerrain(6, 4)).toBe(0);
    expect(s.selectionPreviews).toHaveLength(0);
  });

  it('a waypoint river previews and lays its lake on commit', () => {
    hollow();
    mode('waypoint');
    setLake(true);
    tool.pointerDown({ col: 2, row: 4 }, pev());
    tool.pointerMove({ col: 6, row: 4 }, pev());
    expect(s.selectionPreviews.at(-1)).toHaveLength(2);
    tool.pointerDown({ col: 6, row: 4 }, pev());
    tool.pointerDown({ col: 6, row: 4 }, pev());
    tool.doubleClick();

    expect(s.selectionPreviews.at(-1)).toBeNull();
    expect(s.map.getTerrain(6, 4)).toBe(WATER);
    expect(s.map.getTerrain(7, 4)).toBe(WATER);
    expect(s.map.hasRiver(5, 4)).toBe(true);
  });

  it('Escape on a waypoint river clears the previewed lake', () => {
    hollow();
    mode('waypoint');
    setLake(true);
    tool.pointerDown({ col: 2, row: 4 }, pev());
    tool.pointerMove({ col: 6, row: 4 }, pev());
    expect(s.selectionPreviews.at(-1)).toHaveLength(2);
    tool.keyDown(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(s.selectionPreviews.at(-1)).toBeNull();
    expect(s.map.getTerrain(6, 4)).toBe(0);
  });

  it('toggling the option mid-drag updates the preview', () => {
    hollow();
    mode('straight');
    tool.pointerDown({ col: 2, row: 4 }, pev());
    s.hoveredCell = { col: 6, row: 4 };
    tool.pointerMove({ col: 6, row: 4 }, pev());
    expect(s.selectionPreviews).toHaveLength(0);
    setLake(true);
    expect(s.selectionPreviews.at(-1)).toHaveLength(2);
    setLake(false);
    expect(s.selectionPreviews.at(-1)).toBeNull();
    tool.pointerUp();
    s.hoveredCell = null;
    expect(s.map.getTerrain(6, 4)).toBe(0);
  });

  it('a river that joins an existing river is not a dead end', () => {
    // An existing river runs down col 6 from row 4; a new one ends on it.
    s.map.setRiverOutgoing(6, 4, 3);
    mode('straight');
    setLake(true);
    drag([2, 4], [6, 4]);
    expect(s.map.getTerrain(6, 4)).toBe(0);
    expect(s.map.getOutgoingRiverDir(6, 4)).toBe(3);
    expect(s.map.hasRiver(5, 4)).toBe(true);
  });

  it('on flat ground a capped pond forms around the end, and the river still reaches it', () => {
    mode('straight'); // the fake map is flat: every cell is at the same elevation
    setLake(true);
    drag([2, 4], [6, 4]);
    expect(s.map.getTerrain(6, 4)).toBe(WATER);
    expect(countCells(s.map, (c, r) => s.map.getTerrain(c, r) === WATER)).toBe(7);
    // The pond is the end cell and its ring; the river upstream of it is untouched.
    for (let c = 2; c <= 4; c++) expect(s.map.getTerrain(c, 4), `col ${c}`).toBe(0);
    expect(s.map.getOutgoingRiverDir(4, 4)).toBeGreaterThanOrEqual(0);
  });
});

describe('river endpoint snapping', () => {
  const mode = (m: string) => clickOption(`#river-mode-group .brush-btn[data-river-mode="${m}"]`);
  beforeEach(() => {
    mode('straight');
    drag([2, 4], [4, 4]); // source at (2,4), end at (4,4)
  });

  it('a drag started near a river end snaps onto it, so the old river flows on', () => {
    drag([6, 4], [8, 4]); // 2 cells from the (4,4) end
    expect(s.map.hasRiver(5, 4)).toBe(true);
    expect(s.map.getOutgoingRiverDir(4, 4)).toBeGreaterThanOrEqual(0);
    expect(s.map.getOutgoingRiverDir(8, 4)).toBeLessThan(0);
    expect(downstreamOf(s.map, 4, 4)).toEqual({ col: 5, row: 4 });
  });

  it('never snaps onto a source, and the toggle turns it off', () => {
    drag([0, 4], [1, 4]); // 2 cells from the (2,4) source — a source is not an end
    expect(s.map.hasRiver(0, 4)).toBe(true);
    expect(s.map.getOutgoingRiverDir(2, 4)).toBeGreaterThanOrEqual(0);
    expect(s.map.getIncomingRiverMask(2, 4)).toBe(0);

    (document.getElementById('river-snap') as HTMLInputElement).checked = false;
    drag([6, 4], [8, 4]);
    expect(s.map.hasRiver(5, 4)).toBe(false);
    expect(s.map.hasRiver(6, 4)).toBe(true);
  });

  it('erase drags never snap, and a river that reached water is left alone', () => {
    tool.pointerDown({ col: 6, row: 4 }, pev({ shiftKey: true }));
    expect(hexToOffset((s.previews.at(-1) as HexCoordLike[])[0])).toEqual({ col: 6, row: 4 });
    tool.keyDown(new KeyboardEvent('keydown', { key: 'Escape' }));

    s.map.setTerrain(4, 4, WATER); // the end now sits in water: finished
    drag([6, 4], [8, 4]);
    expect(s.map.hasRiver(5, 4)).toBe(false);
  });

  it('the first waypoint snaps too', () => {
    mode('waypoint');
    tool.pointerDown({ col: 6, row: 4 }, pev());
    tool.pointerDown({ col: 8, row: 4 }, pev());
    tool.keyDown(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(s.map.hasRiver(5, 4)).toBe(true);
    expect(s.map.hasRiver(8, 4)).toBe(true);
  });

  it('the snap row shows in the line modes only', () => {
    const row = document.getElementById('river-snap-row')!;
    for (const m of ['path', 'straight', 'waypoint']) { mode(m); expect(row.classList.contains('hidden'), m).toBe(false); }
    for (const m of ['downhill', 'reverse', 'erase']) { mode(m); expect(row.classList.contains('hidden'), m).toBe(true); }
  });
});
type HexCoordLike = { q: number; r: number };

describe('carving a valley', () => {
  const mode = (m: string) => clickOption(`#river-mode-group .brush-btn[data-river-mode="${m}"]`);

  it('lowers the ground along the river and half as much beside it, as part of the one edit', () => {
    for (let c = 0; c < 12; c++) for (let r = 0; r < 12; r++) s.map.setElevation(c, r, 10);
    setInput('river-carve', '4');
    mode('straight');
    drag([2, 4], [6, 4]);
    for (let c = 2; c <= 6; c++) expect(s.map.getElevation(c, 4)).toBe(6);
    const beside = offsetNeighbor(4, 4, EDGE_DIRS[1]);
    expect(s.map.getElevation(beside.col, beside.row)).toBe(8);
    expect(s.map.getElevation(9, 9)).toBe(10);
    expect(edits.length).toBe(1);
    expect(tool.statusText()).toContain('carve 4');
    edits[0].undo();
    expect(s.map.getElevation(4, 4)).toBe(10);
    expect(s.map.hasRiver(4, 4)).toBe(false);
  });

  it('carving skips water and masked cells and never digs a Shift-erase', () => {
    for (let c = 0; c < 12; c++) for (let r = 0; r < 12; r++) s.map.setElevation(c, r, 10);
    s.map.setTerrain(6, 4, WATER);
    s.selection.apply([{ col: 2, row: 4 }, { col: 3, row: 4 }, { col: 4, row: 4 }, { col: 5, row: 4 }, { col: 6, row: 4 }], 'replace');
    setInput('river-carve', '2');
    mode('straight');
    drag([2, 4], [6, 4]);
    expect(s.map.getElevation(4, 4)).toBe(8);
    expect(s.map.getElevation(6, 4)).toBe(10); // water keeps its floor
    const beside = offsetNeighbor(4, 4, EDGE_DIRS[1]);
    expect(s.map.getElevation(beside.col, beside.row)).toBe(10); // outside the mask
    drag([2, 4], [6, 4], true);
    expect(s.map.getElevation(4, 4)).toBe(8);
  });
});

describe('meander', () => {
  const mode = (m: string) => clickOption(`#river-mode-group .brush-btn[data-river-mode="${m}"]`);
  const fixRng = () => {
    let i = 0;
    const rolls = [0.31, 0.77, 0.12, 0.58, 0.93, 0.44];
    (tool as unknown as { rng: () => number }).rng = () => rolls[i++ % rolls.length];
  };

  it('bends a long line within the amount and keeps it one connected river', () => {
    fixRng();
    setInput('river-meander', '2');
    expect(document.getElementById('river-meander-value')!.textContent).toBe('±2 cells');
    mode('straight');
    drag([0, 5], [11, 5]);
    let bent = 0;
    for (let r = 0; r < 12; r++) for (let c = 0; c < 12; c++) {
      if (!s.map.hasRiver(c, r)) continue;
      expect(Math.abs(r - 5)).toBeLessThanOrEqual(3);
      if (r !== 5) bent++;
    }
    expect(bent).toBeGreaterThan(0);
    // Walk downstream from the source: it reaches the end without a break.
    let cur: { col: number; row: number } | null = { col: 0, row: 5 };
    let steps = 0;
    while (cur && !(cur.col === 11 && cur.row === 5) && steps < 200) { cur = downstreamOf(s.map, cur.col, cur.row); steps++; }
    expect(cur).toEqual({ col: 11, row: 5 });
    expect(edits.length).toBe(1);
    expect(tool.statusText()).toContain('meander ±2');
  });

  it('the preview shows the bends the release lays, and a short line stays straight', () => {
    fixRng();
    setInput('river-meander', '2');
    mode('straight');
    tool.pointerDown({ col: 0, row: 5 }, pev());
    s.hoveredCell = { col: 11, row: 5 };
    tool.pointerMove({ col: 11, row: 5 }, pev());
    const preview = (s.previews.at(-1) as HexCoordLike[]).map(hexToOffset);
    tool.pointerUp();
    for (const { col, row } of preview) expect(s.map.hasRiver(col, row)).toBe(true);
    expect(preview.length).toBe(countCells(s.map, (c, r) => s.map.hasRiver(c, r)));

    drag([0, 9], [3, 9]);
    for (let c = 0; c <= 3; c++) expect(s.map.hasRiver(c, 9)).toBe(true);
    expect(countCells(s.map, (c, r) => s.map.hasRiver(c, r) && r === 9)).toBe(4);
  });

  it('the meander row shows in the drag modes only', () => {
    const row = document.getElementById('river-meander-row')!;
    for (const m of ['path', 'straight']) { mode(m); expect(row.classList.contains('hidden'), m).toBe(false); }
    for (const m of ['waypoint', 'downhill', 'reverse', 'erase']) { mode(m); expect(row.classList.contains('hidden'), m).toBe(true); }
  });
});
