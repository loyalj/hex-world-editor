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

  it('a fast raise drag lifts every cell on the line exactly once', () => {
    tool.pointerDown({ col: 1, row: 4 }, pev());
    tool.pointerMove({ col: 7, row: 4 }, pev());
    tool.pointerMove({ col: 1, row: 4 }, pev()); // back over the same cells
    tool.pointerUp();
    for (let col = 1; col <= 7; col++) expect(s.map.getElevation(col, 4)).toBe(1);
    expect(countCells(s.map, (c, r) => s.map.getElevation(c, r) !== 0)).toBe(7);
    expect(edits.length).toBe(1);
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
    setInput('elev-brush-size', '1');

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

describe('elevation brush shapes and sizing', () => {
  const raised = () => countCells(s.map, (c, r) => s.map.getElevation(c, r) !== 0);
  const rolls = (values: number[]) => {
    let i = 0;
    (tool as unknown as { rng: () => number }).rng = () => values[i++ % values.length];
  };

  it('the size slider and bracket keys drive the radius', () => {
    setInput('elev-brush-size', '2');
    expect(tool.brushRadius()).toBe(2);
    paint(6, 6);
    expect(raised()).toBe(19);
    expect(tool.keyDown(new KeyboardEvent('keydown', { key: ']' }))).toBe(true);
    expect(tool.brushRadius()).toBe(3);
    expect(document.getElementById('elev-brush-size-value')!.textContent).toBe('3 · 37 cells');
    expect(tool.statusText()).toMatch(/brush 37$/);
  });

  it('ring raises only the outer band', () => {
    setInput('elev-brush-size', '2');
    clickOption('#elev-shape-group .scatter-type-btn[data-brush-shape="ring"]');
    paint(6, 6);
    expect(raised()).toBe(12);
    expect(s.map.getElevation(6, 6)).toBe(0);
    expect(tool.hoverFootprint({ col: 6, row: 6 }).length).toBe(12);
    expect(tool.statusText()).toMatch(/ring 12$/);
  });

  it('spray and hardness roll per cell like the terrain brush', () => {
    setInput('elev-brush-size', '1');
    clickOption('#elev-shape-group .scatter-type-btn[data-brush-shape="spray"]');
    setInput('elev-density', '50');
    rolls([0.25, 0.75]);
    paint(6, 6);
    expect(raised()).toBe(4);
    clickOption('#elev-shape-group .scatter-type-btn[data-brush-shape="solid"]');
    setInput('elev-hardness', '0');
    rolls([0.999]);
    paint(2, 2);
    expect(s.map.getElevation(2, 2)).toBe(1);
    expect(raised()).toBe(5);
  });

  it('erosion works over the shaped footprint', () => {
    s.map.setElevation(5, 5, 4);
    setInput('elev-brush-size', '1');
    clickOption('#elev-shape-group .scatter-type-btn[data-brush-shape="ring"]');
    clickOption('#elev-mode-group .density-btn[data-elev-mode="erosion"]');
    paint(5, 5); // the peak is the centre — a ring leaves it alone
    expect(s.map.getElevation(5, 5)).toBe(4);
  });

  it('slope mode has no footprint and ignores the bracket keys', () => {
    setInput('elev-brush-size', '2');
    clickOption('#elev-mode-group .density-btn[data-elev-mode="slope"]');
    expect(tool.brushRadius()).toBe(0);
    expect(tool.hoverFootprint({ col: 3, row: 3 })).toEqual([{ col: 3, row: 3 }]);
    expect(tool.keyDown(new KeyboardEvent('keydown', { key: ']' }))).toBe(false);
  });
});

describe('elevation fill scope', () => {
  const fillScope = () => clickOption('#elev-scope-group .scatter-type-btn[data-elev-scope="fill"]');
  const setContiguous = (on: boolean) => {
    const el = document.getElementById('elev-fill-contiguous') as HTMLInputElement;
    el.checked = on;
    el.dispatchEvent(new Event('change', { bubbles: true }));
  };
  const atElev = (e: number) => countCells(s.map, (c, r) => s.map.getElevation(c, r) === e);
  /** A 3-cell plateau at elevation 5 on an otherwise flat map, plus a far cell at 5. */
  const plateau = () => {
    s.map.setElevation(2, 2, 5);
    s.map.setElevation(3, 2, 5);
    s.map.setElevation(4, 2, 5);
    s.map.setElevation(9, 9, 5);
  };

  it('the fill options show, the brush controls hide, and slope is parked', () => {
    const brush = document.getElementById('elev-brush-group')!;
    const fill  = document.getElementById('elev-fill-group')!;
    const slope = document.querySelector<HTMLButtonElement>('[data-elev-mode="slope"]')!;
    clickOption('#elev-mode-group .density-btn[data-elev-mode="slope"]');
    fillScope();
    expect(brush.classList.contains('hidden')).toBe(true);
    expect(fill.classList.contains('hidden')).toBe(false);
    expect(slope.disabled).toBe(true);
    expect(document.querySelector('#elev-mode-group .active')!.getAttribute('data-elev-mode')).toBe('raise-lower');
    expect(tool.brushRadius()).toBe(0);
    expect(tool.wantsFillCursor()).toBe(true);
    clickOption('#elev-scope-group .scatter-type-btn[data-elev-scope="brush"]');
    expect(brush.classList.contains('hidden')).toBe(false);
    expect(slope.disabled).toBe(false);
  });

  it('raises a contiguous same-elevation region by the step as one edit', () => {
    plateau();
    fillScope();
    tool.pointerDown({ col: 2, row: 2 }, pev());
    tool.pointerUp();
    expect(s.map.getElevation(2, 2)).toBe(6);
    expect(s.map.getElevation(4, 2)).toBe(6);
    expect(s.map.getElevation(9, 9)).toBe(5);
    expect(atElev(6)).toBe(3);
    expect(edits.length).toBe(1);
  });

  it('map-wide fill reaches disconnected cells at the same elevation', () => {
    plateau();
    fillScope();
    setContiguous(false);
    tool.pointerDown({ col: 2, row: 2 }, pev());
    tool.pointerUp();
    expect(s.map.getElevation(9, 9)).toBe(6);
    expect(atElev(6)).toBe(4);
  });

  it('tolerance widens the band; flatten then levels it to the clicked cell', () => {
    s.map.setElevation(2, 2, 5);
    s.map.setElevation(3, 2, 6);
    s.map.setElevation(4, 2, 7);
    s.map.setElevation(5, 2, 9); // outside ±2 of 5
    fillScope();
    setInput('elev-fill-tolerance', '2');
    clickOption('#elev-mode-group .density-btn[data-elev-mode="flatten"]');
    tool.pointerDown({ col: 2, row: 2 }, pev());
    tool.pointerUp();
    expect(s.map.getElevation(3, 2)).toBe(5);
    expect(s.map.getElevation(4, 2)).toBe(5);
    expect(s.map.getElevation(5, 2)).toBe(9);
    expect(edits.length).toBe(1);
  });

  it('terrain match fills the clicked terrain regardless of height', () => {
    s.map.setTerrain(2, 2, 1);
    s.map.setTerrain(3, 2, 1);
    s.map.setElevation(3, 2, 4);
    fillScope();
    clickOption('#elev-fill-match-group .scatter-type-btn[data-fill-match="terrain"]');
    expect(document.getElementById('elev-fill-tolerance-row')!.classList.contains('hidden')).toBe(true);
    clickOption('#elev-mode-group .density-btn[data-elev-mode="set-absolute"]');
    setInput('elev-set-target', '7');
    tool.pointerDown({ col: 2, row: 2 }, pev());
    tool.pointerUp();
    expect(s.map.getElevation(2, 2)).toBe(7);
    expect(s.map.getElevation(3, 2)).toBe(7);
    expect(atElev(7)).toBe(2);
  });

  it('honours the selection mask and the range lock', () => {
    plateau();
    s.selection.setCells([{ col: 2, row: 2 }, { col: 3, row: 2 }]);
    setInput('elev-range-max', '5');
    fillScope();
    s.hoveredCell = { col: 2, row: 2 };
    tool.pointerMove({ col: 2, row: 2 }, pev());
    expect(tool.statusText()).not.toContain('would change'); // clamped: nothing moves
    setInput('elev-range-max', '127');
    expect(tool.statusText()).toContain('would change 2');
    tool.pointerDown({ col: 2, row: 2 }, pev());
    tool.pointerUp();
    expect(s.map.getElevation(4, 2)).toBe(5); // outside the mask
    expect(atElev(6)).toBe(2);
  });

  it('a locked start cell fills nothing', () => {
    plateau();
    s.map.setTerrain(2, 2, 3);
    s.locks.setLocked(3, true);
    fillScope();
    tool.pointerDown({ col: 2, row: 2 }, pev());
    tool.pointerUp();
    expect(edits.length).toBe(0);
  });

  it('erosion in fill scope slumps the whole region', () => {
    s.map.setElevation(5, 5, 4);
    s.map.setElevation(6, 5, 4);
    fillScope();
    clickOption('#elev-mode-group .density-btn[data-elev-mode="erosion"]');
    tool.pointerDown({ col: 5, row: 5 }, pev());
    tool.pointerUp();
    expect(s.map.getElevation(5, 5)).toBe(1);
    expect(s.map.getElevation(6, 5)).toBe(1);
    expect(edits.length).toBe(1);
  });

  it('the hover preview shows the region and the status names the match', () => {
    plateau();
    fillScope();
    tool.pointerMove({ col: 2, row: 2 }, pev());
    expect(s.selectionPreviews.at(-1)).toHaveLength(3);
    expect(tool.statusText()).toMatch(/raise \/ lower \+1 · fill · would change 3$/);
    s.hoveredCell = { col: 2, row: 2 };
    setContiguous(false);
    setInput('elev-fill-tolerance', '1');
    expect(tool.statusText()).toMatch(/fill all · ±1 · would change 4$/);
    // The click retires the preview until the pointer moves again.
    tool.pointerDown({ col: 2, row: 2 }, pev());
    expect(s.selectionPreviews.at(-1)).toBeNull();
    expect(tool.statusText()).not.toContain('would change');
  });

  it('Alt+click still eyedrops in fill scope', () => {
    s.map.setElevation(4, 4, 5);
    fillScope();
    tool.pointerDown({ col: 4, row: 4 }, pev({ altKey: true }));
    tool.pointerUp();
    expect((document.getElementById('elev-set-target') as HTMLInputElement).value).toBe('5');
    expect(edits.length).toBe(0);
  });
});
