// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest';
import type { MapEdit } from '@loyalj/hex-world';
import { TerrainTool } from '../src/tools/terrainTool.ts';
import { clickOption, countCells, loadEditorDom, makeCtx, makeScene, pev, WATER } from './helpers.ts';
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

  it('widens the footprint when a brush radius button is clicked', () => {
    clickOption('#terrain-brush-group .brush-btn[data-brush="1"]');
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
    clickOption('#terrain-brush-group .brush-btn[data-brush="2"]');
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
