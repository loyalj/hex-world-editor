// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest';
import { offsetNeighbor } from '@loyalj/hex-world';
import type { MapEdit } from '@loyalj/hex-world';
import { ElevationTool } from '../src/tools/elevationTool.ts';
import { EDGE_DIRS } from '../src/tools/hexPath.ts';
import { clickOption, countCells, loadEditorDom, makeCtx, makeScene, pev, setInput } from './helpers.ts';
import type { FakeScene } from './helpers.ts';

let s: FakeScene;
let tool: ElevationTool;
let edits: MapEdit[];

beforeEach(() => {
  loadEditorDom();
  s = makeScene();
  const made = makeCtx(s);
  edits = made.edits;
  tool = new ElevationTool(made.ctx);
  // A stale Control-keyup from a previous test must not leak in.
  window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Control' }));
});

const paint = (col: number, row: number): void => {
  tool.pointerDown({ col, row }, pev());
  tool.pointerUp();
};

describe('ElevationTool', () => {
  it('raise-lower steps by the selected step', () => {
    paint(2, 2);
    expect(s.map.getElevation(2, 2)).toBe(1);
    clickOption('#elev-step-group .brush-btn[data-step="-2"]');
    paint(2, 2);
    expect(s.map.getElevation(2, 2)).toBe(-1);
    expect(edits.length).toBe(2);
  });

  it('a drag applies each cell once', () => {
    tool.pointerDown({ col: 2, row: 2 }, pev());
    tool.pointerMove({ col: 2, row: 2 }, pev()); // same cell again
    tool.pointerMove({ col: 3, row: 2 }, pev());
    tool.pointerUp();
    expect(s.map.getElevation(2, 2)).toBe(1);
    expect(s.map.getElevation(3, 2)).toBe(1);
    expect(edits.length).toBe(1);
  });

  it('smooth pulls a spike toward its neighbours', () => {
    s.map.setElevation(5, 5, 7); // neighbours all 0 → round(7/7) = 1
    clickOption('#elev-mode-group .density-btn[data-elev-mode="smooth"]');
    paint(5, 5);
    expect(s.map.getElevation(5, 5)).toBe(1);
  });

  it('flatten drags the first cell\'s elevation across the stroke', () => {
    s.map.setElevation(6, 5, 5);
    clickOption('#elev-mode-group .density-btn[data-elev-mode="flatten"]');
    tool.pointerDown({ col: 2, row: 5 }, pev()); // samples elevation 0
    tool.pointerMove({ col: 6, row: 5 }, pev());
    tool.pointerUp();
    expect(s.map.getElevation(6, 5)).toBe(0);
  });

  it('set-absolute writes the panel target', () => {
    clickOption('#elev-mode-group .density-btn[data-elev-mode="set-absolute"]');
    setInput('elev-set-target', '7');
    paint(3, 3);
    expect(s.map.getElevation(3, 3)).toBe(7);
  });

  it('clamps to the configured range and skips no-op writes', () => {
    setInput('elev-range-max', '3');
    s.map.setElevation(2, 2, 3);
    paint(2, 2); // 3 + 1 clamps back to 3 → nothing changes
    expect(s.map.getElevation(2, 2)).toBe(3);
    expect(edits.length).toBe(0);
  });

  it('slope ramps a line between its endpoint elevations', () => {
    s.map.setElevation(6, 5, 6);
    clickOption('#elev-mode-group .density-btn[data-elev-mode="slope"]');
    tool.pointerDown({ col: 0, row: 5 }, pev());
    tool.pointerMove({ col: 6, row: 5 }, pev());
    tool.pointerUp();
    expect(s.map.getElevation(0, 5)).toBe(0);
    expect(s.map.getElevation(3, 5)).toBe(3);
    expect(s.map.getElevation(6, 5)).toBe(6);
    expect(edits.length).toBe(1);
  });

  it('Escape cancels a slope drag without committing', () => {
    clickOption('#elev-mode-group .density-btn[data-elev-mode="slope"]');
    tool.pointerDown({ col: 0, row: 5 }, pev());
    tool.pointerMove({ col: 6, row: 5 }, pev());
    expect(tool.keyDown(new KeyboardEvent('keydown', { key: 'Escape' }))).toBe(true);
    tool.pointerUp();
    expect(edits.length).toBe(0);
    expect(countCells(s.map, (c, r) => s.map.getElevation(c, r) !== 0)).toBe(0);
  });

  it('erosion slumps a peak toward its neighbours', () => {
    s.map.setElevation(5, 5, 4);
    clickOption('#elev-mode-group .density-btn[data-elev-mode="erosion"]');
    tool.pointerDown({ col: 5, row: 5 }, pev()); // 3 passes × −1
    expect(s.map.getElevation(5, 5)).toBe(1);
    expect(edits.length).toBe(1);
  });

  it('Ctrl held at stroke start snaps the brush to the starting contour', () => {
    const nb = offsetNeighbor(5, 5, EDGE_DIRS[0]);
    s.map.setElevation(5, 5, 2);
    s.map.setElevation(nb.col, nb.row, 2); // one neighbour on the contour
    clickOption('#elev-brush-group .brush-btn[data-brush="1"]');

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Control' }));
    paint(5, 5);
    window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Control' }));

    // Only the two contour cells rose; the other five footprint cells stayed 0.
    expect(s.map.getElevation(5, 5)).toBe(3);
    expect(s.map.getElevation(nb.col, nb.row)).toBe(3);
    expect(countCells(s.map, (c, r) => s.map.getElevation(c, r) === 3)).toBe(2);
  });

  it('Alt+click samples elevation and switches to set-absolute', () => {
    s.map.setElevation(4, 4, 5);
    tool.pointerDown({ col: 4, row: 4 }, pev({ altKey: true }));
    tool.pointerUp();
    expect((document.getElementById('elev-set-target') as HTMLInputElement).value).toBe('5');
    paint(1, 1);
    expect(s.map.getElevation(1, 1)).toBe(5); // now painting in set-absolute mode
  });
});
