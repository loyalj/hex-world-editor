// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest';
import { offsetToHex } from '@loyalj/hex-world';
import type { MapEdit } from '@loyalj/hex-world';
import { TerrainTool } from '../src/tools/terrainTool.ts';
import { hexDistance } from '../src/tools/hexPath.ts';
import { clickOption, countCells, loadEditorDom, makeCtx, makeScene, pev, setInput, WATER } from './helpers.ts';
import type { FakeScene } from './helpers.ts';

let s: FakeScene;
let tool: TerrainTool;
let edits: MapEdit[];

beforeEach(() => {
  loadEditorDom();
  s = makeScene();
  const made = makeCtx(s);
  edits = made.edits;
  tool = new TerrainTool(made.ctx);
});

describe('TerrainTool', () => {
  it('paints a cell and commits one undoable edit per stroke', () => {
    tool.paintTerrain = 1;
    tool.pointerDown({ col: 2, row: 2 }, pev());
    tool.pointerMove({ col: 3, row: 2 }, pev());
    tool.pointerUp();

    expect(s.map.getTerrain(2, 2)).toBe(1);
    expect(s.map.getTerrain(3, 2)).toBe(1);
    expect(edits.length).toBe(1);

    edits[0].undo();
    expect(s.map.getTerrain(2, 2)).toBe(0);
    expect(s.map.getTerrain(3, 2)).toBe(0);
    edits[0].redo();
    expect(s.map.getTerrain(2, 2)).toBe(1);
  });

  it('a fast drag paints every cell along the line between pointer positions', () => {
    tool.paintTerrain = 1;
    tool.pointerDown({ col: 1, row: 5 }, pev());
    tool.pointerMove({ col: 9, row: 5 }, pev()); // one event, eight cells apart
    tool.pointerUp();
    for (let col = 1; col <= 9; col++) expect(s.map.getTerrain(col, 5)).toBe(1);
    expect(countCells(s.map, (c, r) => s.map.getTerrain(c, r) === 1)).toBe(9);
    expect(edits.length).toBe(1);
  });

  it('interpolation follows diagonals and never touches cells off the line', () => {
    tool.paintTerrain = 1;
    tool.pointerDown({ col: 2, row: 2 }, pev());
    tool.pointerMove({ col: 6, row: 8 }, pev());
    tool.pointerUp();
    expect(s.map.getTerrain(2, 2)).toBe(1);
    expect(s.map.getTerrain(6, 8)).toBe(1);
    const length = hexDistance(offsetToHex(2, 2), offsetToHex(6, 8)) + 1;
    expect(countCells(s.map, (c, r) => s.map.getTerrain(c, r) === 1)).toBe(length);
  });

  it('each stroke starts a fresh line: the next stroke does not join the last', () => {
    tool.paintTerrain = 1;
    tool.pointerDown({ col: 1, row: 1 }, pev());
    tool.pointerUp();
    tool.pointerDown({ col: 9, row: 9 }, pev());
    tool.pointerUp();
    expect(countCells(s.map, (c, r) => s.map.getTerrain(c, r) === 1)).toBe(2);
  });

  it('skips cells whose terrain is locked', () => {
    s.map.setTerrain(4, 4, 2);
    s.locks.setLocked(2, true);
    tool.paintTerrain = 1;
    tool.pointerDown({ col: 4, row: 4 }, pev());
    tool.pointerUp();
    expect(s.map.getTerrain(4, 4)).toBe(2);
    expect(edits.length).toBe(0);
  });

  it('lifts a drowned cell to elevation 0 when painting land over water', () => {
    s.map.setTerrain(4, 4, WATER);
    s.map.setElevation(4, 4, -3);
    tool.paintTerrain = 0; // grassland
    tool.pointerDown({ col: 4, row: 4 }, pev());
    tool.pointerUp();
    expect(s.map.getTerrain(4, 4)).toBe(0);
    expect(s.map.getElevation(4, 4)).toBe(0);
  });

  it('widens the footprint when the size slider moves', () => {
    setInput('terrain-brush-size', '1');
    tool.paintTerrain = 2;
    tool.pointerDown({ col: 5, row: 5 }, pev());
    tool.pointerUp();
    expect(countCells(s.map, (c, r) => s.map.getTerrain(c, r) === 2)).toBe(7);
  });

  it('flood fill converts exactly the connected region', () => {
    s.map.setTerrain(2, 2, 1);
    s.map.setTerrain(3, 2, 1);
    s.map.setTerrain(8, 8, 1); // same terrain, not connected
    clickOption('#terrain-mode-group .scatter-type-btn[data-terrain-mode="fill"]');
    tool.paintTerrain = 3;
    tool.pointerDown({ col: 2, row: 2 }, pev());

    expect(s.map.getTerrain(2, 2)).toBe(3);
    expect(s.map.getTerrain(3, 2)).toBe(3);
    expect(s.map.getTerrain(8, 8)).toBe(1);
    expect(countCells(s.map, (c, r) => s.map.getTerrain(c, r) === 3)).toBe(2);
    expect(edits.length).toBe(1);
  });

  it('Alt+click samples terrain without painting', () => {
    s.map.setTerrain(6, 6, 4);
    const sampled: number[] = [];
    tool.onTerrainSampled = i => sampled.push(i);
    tool.pointerDown({ col: 6, row: 6 }, pev({ altKey: true }));
    tool.pointerUp();
    expect(tool.paintTerrain).toBe(4);
    expect(sampled).toEqual([4]);
    expect(s.map.getTerrain(6, 6)).toBe(4);
    expect(edits.length).toBe(0);
  });

  it('fill mode hides the brush size controls and shrinks the footprint', () => {
    const header = document.getElementById('terrain-brush-header')!;
    const group  = document.getElementById('terrain-brush-group')!;
    setInput('terrain-brush-size', '2');
    expect(tool.brushRadius()).toBe(2);

    clickOption('#terrain-mode-group .scatter-type-btn[data-terrain-mode="fill"]');
    expect(header.classList.contains('hidden')).toBe(true);
    expect(group.classList.contains('hidden')).toBe(true);
    expect(tool.brushRadius()).toBe(0);

    clickOption('#terrain-mode-group .scatter-type-btn[data-terrain-mode="brush"]');
    expect(header.classList.contains('hidden')).toBe(false);
    expect(group.classList.contains('hidden')).toBe(false);
    expect(tool.brushRadius()).toBe(2);
  });

  it('flood fill lifts drowned cells like the brush does', () => {
    s.map.setTerrain(2, 2, WATER);
    s.map.setTerrain(3, 2, WATER);
    s.map.setElevation(3, 2, -4);
    clickOption('#terrain-mode-group .scatter-type-btn[data-terrain-mode="fill"]');
    tool.paintTerrain = 1;
    tool.pointerDown({ col: 2, row: 2 }, pev());

    expect(s.map.getTerrain(3, 2)).toBe(1);
    expect(s.map.getElevation(3, 2)).toBe(0);
    expect(edits.length).toBe(1);
  });

  it('painting the same terrain twice opens no transaction', () => {
    tool.paintTerrain = 0; // everything already is 0
    tool.pointerDown({ col: 1, row: 1 }, pev());
    tool.pointerUp();
    expect(edits.length).toBe(0);
  });
});

describe('fill hover preview', () => {
  const lastPreview = () =>
    s.selectionPreviews[s.selectionPreviews.length - 1] as Array<{ col: number; row: number }> | null;

  beforeEach(() => {
    clickOption('#terrain-mode-group .scatter-type-btn[data-terrain-mode="fill"]');
    tool.paintTerrain = 3;
  });

  it('hovering shows the region a fill click would paint', () => {
    s.map.setTerrain(2, 2, 1);
    s.map.setTerrain(3, 2, 1);
    s.map.setTerrain(8, 8, 1); // same terrain, not connected — stays out
    tool.pointerMove({ col: 2, row: 2 }, pev());
    expect(lastPreview()).toHaveLength(2);
    expect(lastPreview()).toEqual(
      expect.arrayContaining([{ col: 2, row: 2 }, { col: 3, row: 2 }]));
    expect(tool.statusText()).toContain('would paint 2');
    expect(edits.length).toBe(0); // preview never edits
  });

  it('previews nothing when the region already is the paint terrain', () => {
    s.map.setTerrain(2, 2, 3);
    tool.pointerMove({ col: 2, row: 2 }, pev());
    expect(lastPreview()).toHaveLength(0);
  });

  it('locked terrain under the cursor previews nothing', () => {
    s.locks.setLocked(0, true);
    tool.pointerMove({ col: 2, row: 2 }, pev());
    expect(lastPreview()).toHaveLength(0);
  });

  it('leaving the map clears the preview', () => {
    tool.pointerMove({ col: 2, row: 2 }, pev());
    tool.pointerMove(null, pev());
    expect(lastPreview()).toBeNull();
  });

  it('the fill click retires the now-stale preview', () => {
    tool.pointerMove({ col: 2, row: 2 }, pev());
    tool.pointerDown({ col: 2, row: 2 }, pev());
    expect(lastPreview()).toBeNull();
    expect(tool.statusText()).not.toContain('would paint');
  });

  it('switching back to brush mode drops the preview and never re-previews', () => {
    tool.pointerMove({ col: 2, row: 2 }, pev());
    clickOption('#terrain-mode-group .scatter-type-btn[data-terrain-mode="brush"]');
    expect(lastPreview()).toBeNull();
    const previews = s.selectionPreviews.length;
    tool.pointerMove({ col: 4, row: 4 }, pev());
    expect(s.selectionPreviews.length).toBe(previews);
  });

  it('picking a different paint terrain recomputes the preview in place', () => {
    s.hoveredCell = { col: 2, row: 2 };
    tool.pointerMove({ col: 2, row: 2 }, pev());
    expect(lastPreview()!.length).toBeGreaterThan(0);
    tool.paintTerrain = 0; // the hovered region already is 0 — now a no-op
    expect(lastPreview()).toHaveLength(0);
  });
});

describe('brush shapes and sizing', () => {
  const painted = () => countCells(s.map, (c, r) => s.map.getTerrain(c, r) === 2);
  const stampAt = (col: number, row: number) => {
    tool.paintTerrain = 2;
    tool.pointerDown({ col, row }, pev());
    tool.pointerUp();
  };
  /** Feed the tool a fixed roll sequence in place of Math.random. */
  const rolls = (values: number[]) => {
    let i = 0;
    (tool as unknown as { rng: () => number }).rng = () => values[i++ % values.length];
  };

  it('reaches radii beyond the old four presets', () => {
    setInput('terrain-brush-size', '5');
    expect(tool.brushRadius()).toBe(5);
    expect(document.getElementById('terrain-brush-size-value')!.textContent).toBe('5 · 91 cells');
    // A 12×12 map clips the footprint; the readout still quotes the full brush.
    stampAt(6, 6);
    expect(painted()).toBeGreaterThan(37);
  });

  it('[ and ] step the size, Shift steps by 5, and the range is clamped', () => {
    const key = (k: string, shiftKey = false) => tool.keyDown(new KeyboardEvent('keydown', { key: k, shiftKey }));
    expect(key(']')).toBe(true);
    expect(key(']')).toBe(true);
    expect(tool.brushRadius()).toBe(2);
    expect((document.getElementById('terrain-brush-size') as HTMLInputElement).value).toBe('2');
    expect(key('}', true)).toBe(true);
    expect(tool.brushRadius()).toBe(7);
    for (let i = 0; i < 20; i++) key('[');
    expect(tool.brushRadius()).toBe(0);
    for (let i = 0; i < 20; i++) key('}', true);
    expect(tool.brushRadius()).toBe(12);
  });

  it('bracket keys are not consumed in fill mode or with Ctrl held', () => {
    expect(tool.keyDown(new KeyboardEvent('keydown', { key: ']', ctrlKey: true }))).toBe(false);
    clickOption('#terrain-mode-group .scatter-type-btn[data-terrain-mode="fill"]');
    expect(tool.keyDown(new KeyboardEvent('keydown', { key: ']' }))).toBe(false);
    expect(tool.keyDown(new KeyboardEvent('keydown', { key: 'x' }))).toBe(false);
  });

  it('ring paints only the outer band', () => {
    setInput('terrain-brush-size', '2');
    clickOption('#terrain-shape-group .scatter-type-btn[data-brush-shape="ring"]');
    stampAt(6, 6);
    expect(painted()).toBe(12);
    expect(s.map.getTerrain(6, 6)).toBe(0);
    expect(document.getElementById('terrain-brush-size-value')!.textContent).toBe('2 · 12 cells');
  });

  it('a radius-0 ring is the single cell', () => {
    clickOption('#terrain-shape-group .scatter-type-btn[data-brush-shape="ring"]');
    stampAt(6, 6);
    expect(painted()).toBe(1);
  });

  it('spray paints the share of the footprint its density allows', () => {
    setInput('terrain-brush-size', '2');
    clickOption('#terrain-shape-group .scatter-type-btn[data-brush-shape="spray"]');
    setInput('terrain-density', '50');
    rolls([0.25, 0.75]); // alternate pass, fail
    stampAt(6, 6);
    expect(painted()).toBe(10);
    setInput('terrain-density', '100');
    stampAt(6, 6);
    expect(painted()).toBe(19);
  });

  it('spray rolls each cell once per stroke, so re-crossing a cell never fills it in', () => {
    setInput('terrain-brush-size', '1');
    clickOption('#terrain-shape-group .scatter-type-btn[data-brush-shape="spray"]');
    setInput('terrain-density', '50');
    rolls([0.9]); // every roll fails
    tool.paintTerrain = 2;
    tool.pointerDown({ col: 6, row: 6 }, pev());
    tool.pointerMove({ col: 7, row: 6 }, pev());
    tool.pointerMove({ col: 6, row: 6 }, pev());
    tool.pointerUp();
    expect(painted()).toBe(0);
    expect(edits.length).toBe(0);
  });

  it('full hardness paints every cell of a solid brush', () => {
    setInput('terrain-brush-size', '2');
    rolls([0.999]);
    stampAt(6, 6);
    expect(painted()).toBe(19);
  });

  it('zero hardness keeps only the centre certain and softens the rim', () => {
    setInput('terrain-brush-size', '2');
    setInput('terrain-hardness', '0');
    rolls([0.999]); // every roll fails: only weight-1 cells paint
    stampAt(6, 6);
    expect(painted()).toBe(1);
    expect(s.map.getTerrain(6, 6)).toBe(2);
    rolls([0]); // every roll passes: the whole footprint paints
    stampAt(2, 2);
    expect(painted()).toBe(1 + 19);
  });

  it('shape switches show the slider that applies to it', () => {
    const hardness = document.getElementById('terrain-hardness-row')!;
    const density  = document.getElementById('terrain-density-row')!;
    expect(hardness.classList.contains('hidden')).toBe(false);
    expect(density.classList.contains('hidden')).toBe(true);
    clickOption('#terrain-shape-group .scatter-type-btn[data-brush-shape="spray"]');
    expect(hardness.classList.contains('hidden')).toBe(true);
    expect(density.classList.contains('hidden')).toBe(false);
    clickOption('#terrain-shape-group .scatter-type-btn[data-brush-shape="ring"]');
    expect(hardness.classList.contains('hidden')).toBe(true);
    expect(density.classList.contains('hidden')).toBe(true);
  });

  it('hover footprint follows the shape and collapses to one cell in fill mode', () => {
    setInput('terrain-brush-size', '2');
    expect(tool.hoverFootprint({ col: 6, row: 6 }).length).toBe(19);
    clickOption('#terrain-shape-group .scatter-type-btn[data-brush-shape="ring"]');
    expect(tool.hoverFootprint({ col: 6, row: 6 }).length).toBe(12);
    clickOption('#terrain-mode-group .scatter-type-btn[data-terrain-mode="fill"]');
    expect(tool.hoverFootprint({ col: 6, row: 6 })).toEqual([{ col: 6, row: 6 }]);
  });

  it('status text names the shape and expected cell count', () => {
    setInput('terrain-brush-size', '1');
    expect(tool.statusText()).toMatch(/brush 7$/);
    clickOption('#terrain-shape-group .scatter-type-btn[data-brush-shape="ring"]');
    expect(tool.statusText()).toMatch(/ring 6$/);
    clickOption('#terrain-shape-group .scatter-type-btn[data-brush-shape="spray"]');
    setInput('terrain-density', '50');
    expect(tool.statusText()).toMatch(/spray ~4 of 7$/);
  });
});

describe('fill matching and scope', () => {
  const fillMode = () => clickOption('#terrain-mode-group .scatter-type-btn[data-terrain-mode="fill"]');
  const match = (m: string) => clickOption(`#terrain-fill-match-group .scatter-type-btn[data-fill-match="${m}"]`);
  const setContiguous = (on: boolean) => {
    const el = document.getElementById('terrain-fill-contiguous') as HTMLInputElement;
    el.checked = on;
    el.dispatchEvent(new Event('change', { bubbles: true }));
  };
  const painted = (t: number) => countCells(s.map, (c, r) => s.map.getTerrain(c, r) === t);
  const chips = () => Array.from(document.querySelectorAll<HTMLButtonElement>('#terrain-fill-set .terrain-filter-btn'));
  const roster = [
    { index: 0, id: 'a', name: 'A', color: 0x111111, texture: { type: 'procedural' as const } },
    { index: 1, id: 'b', name: 'B', color: 0x222222, texture: { type: 'procedural' as const } },
    { index: 3, id: 'd', name: 'D', color: 0x444444, texture: { type: 'procedural' as const } },
  ];

  it('the fill options only show in fill mode', () => {
    const group = document.getElementById('terrain-fill-group')!;
    expect(group.classList.contains('hidden')).toBe(true);
    fillMode();
    expect(group.classList.contains('hidden')).toBe(false);
    clickOption('#terrain-mode-group .scatter-type-btn[data-terrain-mode="brush"]');
    expect(group.classList.contains('hidden')).toBe(true);
  });

  it('map-wide exact fill paints disconnected patches of the clicked terrain', () => {
    s.map.setTerrain(2, 2, 1);
    s.map.setTerrain(9, 9, 1);
    fillMode();
    setContiguous(false);
    tool.paintTerrain = 3;
    tool.pointerDown({ col: 2, row: 2 }, pev());
    expect(s.map.getTerrain(9, 9)).toBe(3);
    expect(painted(3)).toBe(2);
    expect(edits.length).toBe(1);
  });

  it('map-wide fill honours the selection mask and locks', () => {
    s.map.setTerrain(2, 2, 1);
    s.map.setTerrain(9, 9, 1);
    s.map.setTerrain(5, 5, 2);
    s.locks.setLocked(2, true);
    s.selection.setCells([{ col: 9, row: 9 }, { col: 5, row: 5 }]);
    fillMode();
    setContiguous(false);
    tool.paintTerrain = 3;
    tool.pointerDown({ col: 2, row: 2 }, pev()); // outside the mask, but the scope is the map
    expect(s.map.getTerrain(2, 2)).toBe(1);
    expect(s.map.getTerrain(9, 9)).toBe(3);
    expect(s.map.getTerrain(5, 5)).toBe(2);
  });

  it('category fill treats neighbouring solids as one region and stops at water', () => {
    s.map.setTerrain(2, 2, 1);
    s.map.setTerrain(3, 2, 2);
    s.map.setTerrain(4, 2, WATER);
    s.map.setTerrain(5, 2, 1); // solid on the far side, still connected around the water
    fillMode();
    match('category');
    tool.paintTerrain = 3;
    tool.pointerDown({ col: 2, row: 2 }, pev());
    expect(s.map.getTerrain(2, 2)).toBe(3);
    expect(s.map.getTerrain(3, 2)).toBe(3);
    expect(s.map.getTerrain(4, 2)).toBe(WATER);
    // Everything else solid was connected through terrain 0 — one big fill.
    expect(painted(WATER)).toBe(1);
    expect(painted(3)).toBe(12 * 12 - 1);
  });

  it('category fill from a liquid cell paints only liquids', () => {
    s.map.setTerrain(6, 6, WATER);
    s.map.setTerrain(7, 6, WATER);
    fillMode();
    match('category');
    tool.paintTerrain = 3;
    tool.pointerDown({ col: 6, row: 6 }, pev());
    expect(painted(3)).toBe(2);
  });

  it('cells already holding the paint terrain carry the flood but are not rewritten', () => {
    // 1 | 3 | 1 in a row: a category fill with paint 3 must reach the far 1
    // through the 3 without touching the 3 itself.
    s.map.setTerrain(2, 2, 1);
    s.map.setTerrain(3, 2, 3);
    s.map.setTerrain(4, 2, 1);
    s.selection.setCells([{ col: 2, row: 2 }, { col: 3, row: 2 }, { col: 4, row: 2 }]);
    fillMode();
    match('category');
    tool.paintTerrain = 3;
    tool.pointerMove({ col: 2, row: 2 }, pev());
    expect(tool.statusText()).toContain('would paint 2');
    tool.pointerDown({ col: 2, row: 2 }, pev());
    expect(painted(3)).toBe(3);
  });

  it('custom set fills the ticked terrains map-wide, wherever the click lands', () => {
    tool.refreshFillSet(roster);
    expect(chips().length).toBe(3);
    s.map.setTerrain(1, 1, 1);
    s.map.setTerrain(9, 9, 3);
    s.map.setTerrain(5, 5, 2); // not in the roster, never ticked
    fillMode();
    match('set');
    chips()[1].click(); // B (index 1)
    chips()[2].click(); // D (index 3)
    setContiguous(false);
    tool.paintTerrain = 4;
    tool.pointerDown({ col: 5, row: 5 }, pev()); // click on terrain 2
    expect(s.map.getTerrain(1, 1)).toBe(4);
    expect(s.map.getTerrain(9, 9)).toBe(4);
    expect(s.map.getTerrain(5, 5)).toBe(2);
    expect(painted(4)).toBe(2);
  });

  it('contiguous custom set needs the clicked cell to be in the set', () => {
    tool.refreshFillSet(roster);
    s.map.setTerrain(1, 1, 1);
    s.map.setTerrain(2, 1, 3);
    fillMode();
    match('set');
    chips()[1].click(); // B only
    tool.paintTerrain = 4;
    tool.pointerDown({ col: 2, row: 1 }, pev()); // D: not ticked → nothing
    expect(painted(4)).toBe(0);
    expect(edits.length).toBe(0);
    tool.pointerDown({ col: 1, row: 1 }, pev());
    expect(painted(4)).toBe(1);
  });

  it('an empty custom set falls back to the clicked terrain', () => {
    tool.refreshFillSet(roster);
    s.map.setTerrain(1, 1, 1);
    s.map.setTerrain(2, 1, 1);
    fillMode();
    match('set');
    tool.paintTerrain = 4;
    tool.pointerDown({ col: 1, row: 1 }, pev());
    expect(painted(4)).toBe(2);
  });

  it('chips keep their ticks across a roster refresh and drop removed terrains', () => {
    tool.refreshFillSet(roster);
    chips()[1].click();
    chips()[2].click();
    tool.refreshFillSet(roster.slice(0, 2)); // D removed
    expect(chips().map(c => c.classList.contains('active'))).toEqual([false, true]);
    s.map.setTerrain(9, 9, 3);
    fillMode();
    match('set');
    setContiguous(false);
    tool.paintTerrain = 4;
    tool.pointerDown({ col: 0, row: 0 }, pev());
    expect(s.map.getTerrain(9, 9)).toBe(3);
  });

  it('the hover preview and status follow the match and scope options', () => {
    s.map.setTerrain(2, 2, 1);
    s.map.setTerrain(9, 9, 1);
    fillMode();
    tool.paintTerrain = 3;
    // Option changes rebuild the preview from the scene's hovered cell.
    s.hoveredCell = { col: 2, row: 2 };
    tool.pointerMove({ col: 2, row: 2 }, pev());
    expect(tool.statusText()).toMatch(/fill · would paint 1$/);
    setContiguous(false);
    expect(tool.statusText()).toMatch(/fill all · would paint 2$/);
    match('category');
    expect(tool.statusText()).toMatch(/fill all · category · would paint 144$/);
    expect(s.selectionPreviews.at(-1)).toHaveLength(144);
  });
});

describe('Shift+click lines', () => {
  const painted = () => countCells(s.map, (c, r) => s.map.getTerrain(c, r) === 1);

  it('stamps the line from the previous stroke\'s end to the click', () => {
    tool.paintTerrain = 1;
    tool.pointerDown({ col: 1, row: 5 }, pev());
    tool.pointerUp();
    tool.pointerDown({ col: 9, row: 5 }, pev({ shiftKey: true }));
    tool.pointerUp();
    for (let col = 1; col <= 9; col++) expect(s.map.getTerrain(col, 5)).toBe(1);
    expect(painted()).toBe(9);
    expect(edits.length).toBe(2); // the line is its own undo step
  });

  it('chains: each Shift+click continues from the last', () => {
    tool.paintTerrain = 1;
    tool.pointerDown({ col: 1, row: 1 }, pev());
    tool.pointerUp();
    tool.pointerDown({ col: 5, row: 1 }, pev({ shiftKey: true }));
    tool.pointerUp();
    tool.pointerDown({ col: 5, row: 6 }, pev({ shiftKey: true }));
    tool.pointerUp();
    expect(s.map.getTerrain(3, 1)).toBe(1);
    expect(s.map.getTerrain(5, 4)).toBe(1);
  });

  it('the anchor is the end of a drag, not its start', () => {
    tool.paintTerrain = 1;
    tool.pointerDown({ col: 1, row: 1 }, pev());
    tool.pointerMove({ col: 1, row: 8 }, pev());
    tool.pointerUp();
    tool.pointerDown({ col: 8, row: 8 }, pev({ shiftKey: true }));
    tool.pointerUp();
    expect(s.map.getTerrain(4, 8)).toBe(1);
    expect(s.map.getTerrain(4, 1)).toBe(0);
  });

  it('Shift without an anchor, or after a tool switch, is a plain click', () => {
    tool.paintTerrain = 1;
    tool.pointerDown({ col: 9, row: 5 }, pev({ shiftKey: true }));
    tool.pointerUp();
    expect(painted()).toBe(1);
    tool.deactivate();
    tool.pointerDown({ col: 1, row: 5 }, pev({ shiftKey: true }));
    tool.pointerUp();
    expect(painted()).toBe(2);
  });
});

describe('honest brush counts', () => {
  it('quotes the footprint alone until something is hovered', () => {
    setInput('terrain-brush-size', '1');
    tool.paintTerrain = 2;
    expect(tool.statusText()).toMatch(/brush 7$/);
  });

  it('counts only the cells a click would actually change', () => {
    setInput('terrain-brush-size', '1');
    tool.paintTerrain = 2;
    s.map.setTerrain(5, 5, 2);            // already the paint terrain
    s.map.setTerrain(6, 5, 3);
    s.locks.setLocked(3, true);           // locked
    s.selection.setCells([{ col: 5, row: 5 }, { col: 6, row: 5 }, { col: 4, row: 5 }, { col: 5, row: 4 }]);
    s.hoveredCell = { col: 5, row: 5 };
    // Footprint 7; masked to 4; one locked, one already painted → 2.
    expect(tool.statusText()).toMatch(/brush 7 · would paint 2$/);
  });

  it('clips the count at the map edge and says "up to" for a spray', () => {
    setInput('terrain-brush-size', '1');
    tool.paintTerrain = 2;
    s.hoveredCell = { col: 0, row: 0 };
    expect(tool.statusText()).toMatch(/would paint 3$/);
    clickOption('#terrain-shape-group .scatter-type-btn[data-brush-shape="spray"]');
    expect(tool.statusText()).toMatch(/would paint up to 3$/);
  });
});

describe('fill preview cache', () => {
  const builds = () => (tool as unknown as { fillIndexBuilds: number }).fillIndexBuilds;
  const fillMode = () => clickOption('#terrain-mode-group .scatter-type-btn[data-terrain-mode="fill"]');

  it('serves every hover from one component index until something changes', () => {
    s.map.setTerrain(2, 2, 1);
    s.map.setTerrain(3, 2, 1);
    fillMode();
    tool.paintTerrain = 3;
    tool.pointerMove({ col: 2, row: 2 }, pev());
    expect(builds()).toBe(1);
    tool.pointerMove({ col: 3, row: 2 }, pev());
    tool.pointerMove({ col: 8, row: 8 }, pev());
    expect(builds()).toBe(1);
    expect(tool.statusText()).toContain('would paint 142');
  });

  it('rebuilds after the map, mask, or roster changes', () => {
    fillMode();
    tool.paintTerrain = 3;
    tool.pointerMove({ col: 2, row: 2 }, pev());
    expect(builds()).toBe(1);
    s.map.setTerrain(5, 5, 1);
    s.bumpRevision(); // what history.onChange does in the app
    tool.pointerMove({ col: 3, row: 2 }, pev());
    expect(builds()).toBe(2);
    expect(tool.statusText()).toContain('would paint 143');
    s.selection.setCells([{ col: 2, row: 2 }]); // the fake's selection has no scene hook — bump by hand
    s.bumpRevision();
    tool.pointerMove({ col: 2, row: 2 }, pev());
    expect(builds()).toBe(3);
    expect(tool.statusText()).toContain('would paint 1');
    tool.refreshFillSet([]);
    tool.pointerMove({ col: 3, row: 2 }, pev());
    expect(builds()).toBe(4);
  });

  it('rebuilds when the match mode changes, and a fill click sees the fresh map', () => {
    s.map.setTerrain(2, 2, WATER);
    fillMode();
    tool.paintTerrain = 3;
    tool.pointerMove({ col: 2, row: 2 }, pev());
    expect(builds()).toBe(1);
    clickOption('#terrain-fill-match-group .scatter-type-btn[data-fill-match="category"]');
    s.hoveredCell = { col: 2, row: 2 };
    tool.pointerMove({ col: 2, row: 2 }, pev());
    expect(builds()).toBe(2);
    tool.pointerDown({ col: 2, row: 2 }, pev());
    expect(s.map.getTerrain(2, 2)).toBe(3);
    // The click committed an edit, which bumped the revision: the next hover rebuilds.
    tool.pointerMove({ col: 3, row: 2 }, pev());
    expect(builds()).toBe(3);
  });
});

describe('fill by elevation', () => {
  const fillMode = () => clickOption('#terrain-mode-group .scatter-type-btn[data-terrain-mode="fill"]');
  const elevation = () => clickOption('#terrain-fill-match-group .scatter-type-btn[data-fill-match="elevation"]');
  const setContiguous = (on: boolean) => {
    const el = document.getElementById('terrain-fill-contiguous') as HTMLInputElement;
    el.checked = on;
    el.dispatchEvent(new Event('change', { bubbles: true }));
  };
  const painted = (t: number) => countCells(s.map, (c, r) => s.map.getTerrain(c, r) === t);
  const builds = () => (tool as unknown as { fillIndexBuilds: number }).fillIndexBuilds;
  /** A three-cell ridge at 5 (mixed terrains), a step at 6 beside it, a far cell at 5. */
  const ridge = () => {
    s.map.setElevation(2, 2, 5); s.map.setTerrain(2, 2, 1);
    s.map.setElevation(3, 2, 5); s.map.setTerrain(3, 2, 2);
    s.map.setElevation(4, 2, 5);
    s.map.setElevation(5, 2, 6);
    s.map.setElevation(9, 9, 5);
  };

  it('the tolerance field shows only for the elevation match', () => {
    fillMode();
    const row = document.getElementById('terrain-fill-tolerance-row')!;
    expect(row.classList.contains('hidden')).toBe(true);
    elevation();
    expect(row.classList.contains('hidden')).toBe(false);
    clickOption('#terrain-fill-match-group .scatter-type-btn[data-fill-match="exact"]');
    expect(row.classList.contains('hidden')).toBe(true);
  });

  it('paints the connected cells at the clicked height, whatever their terrain', () => {
    ridge();
    fillMode();
    elevation();
    tool.paintTerrain = 4;
    tool.pointerDown({ col: 2, row: 2 }, pev());
    expect(s.map.getTerrain(3, 2)).toBe(4);
    expect(s.map.getTerrain(4, 2)).toBe(4);
    expect(s.map.getTerrain(5, 2)).toBe(0); // one step higher
    expect(s.map.getTerrain(9, 9)).toBe(0); // same height, not connected
    expect(painted(4)).toBe(3);
    expect(edits.length).toBe(1);
  });

  it('a tolerance widens the band and bypasses the component index', () => {
    ridge();
    fillMode();
    elevation();
    tool.paintTerrain = 4;
    tool.pointerMove({ col: 2, row: 2 }, pev());
    expect(builds()).toBe(1);
    s.hoveredCell = { col: 2, row: 2 };
    setInput('terrain-fill-tolerance', '1');
    expect(tool.statusText()).toMatch(/fill · elevation ±1 · would paint 4$/);
    tool.pointerMove({ col: 3, row: 2 }, pev());
    expect(builds()).toBe(1); // no rebuild: the band floods directly
    tool.pointerDown({ col: 2, row: 2 }, pev());
    expect(s.map.getTerrain(5, 2)).toBe(4);
    expect(painted(4)).toBe(4);
  });

  it('map-wide elevation fill reaches disconnected cells of that height', () => {
    ridge();
    fillMode();
    elevation();
    setContiguous(false);
    tool.paintTerrain = 4;
    tool.pointerDown({ col: 2, row: 2 }, pev());
    expect(s.map.getTerrain(9, 9)).toBe(4);
    expect(painted(4)).toBe(4);
    setInput('terrain-fill-tolerance', '1');
    tool.pointerDown({ col: 9, row: 9 }, pev()); // ±1 around 5 map-wide: only (5,2) at 6 remains
    expect(s.map.getTerrain(5, 2)).toBe(4);
  });

  it('honours mask and locks, and skips cells already the paint terrain', () => {
    ridge();
    s.locks.setLocked(2, true);                       // (3,2) locked
    s.selection.setCells([{ col: 2, row: 2 }, { col: 3, row: 2 }, { col: 4, row: 2 }]);
    fillMode();
    elevation();
    tool.paintTerrain = 1;                            // (2,2) already 1
    s.hoveredCell = { col: 2, row: 2 };
    tool.pointerMove({ col: 2, row: 2 }, pev());
    // (3,2) is a wall, so (4,2) is cut off: only the clicked cell remains, and it's already painted.
    expect(tool.statusText()).not.toContain('would paint');
    tool.pointerDown({ col: 2, row: 2 }, pev());
    expect(edits.length).toBe(0);
  });
});
