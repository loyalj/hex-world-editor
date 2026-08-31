// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest';
import { SelectionTool } from '../src/tools/selectionTool.ts';
import { clickOption, loadEditorDom, makeCtx, makeScene, pev } from './helpers.ts';
import type { FakeScene } from './helpers.ts';

let s: FakeScene;
let tool: SelectionTool;

beforeEach(() => {
  loadEditorDom();
  s = makeScene();
  tool = new SelectionTool(makeCtx(s).ctx);
});

const setCheckbox = (id: string, checked: boolean): void => {
  const el = document.getElementById(id) as HTMLInputElement;
  el.checked = checked;
  el.dispatchEvent(new Event('change', { bubbles: true }));
};

describe('pointer mode', () => {
  it('click replaces; Shift adds; Alt removes', () => {
    tool.pointerDown({ col: 2, row: 2 }, pev());
    tool.pointerUp();
    tool.pointerDown({ col: 3, row: 2 }, pev({ shiftKey: true }));
    tool.pointerUp();
    expect(s.selection.size).toBe(2);

    tool.pointerDown({ col: 2, row: 2 }, pev({ altKey: true }));
    tool.pointerUp();
    expect(s.selection.size).toBe(1);
    expect(s.selection.has(3, 2)).toBe(true);

    tool.pointerDown({ col: 5, row: 5 }, pev());
    tool.pointerUp();
    expect(s.selection.size).toBe(1);
    expect(s.selection.has(5, 5)).toBe(true);
  });

  it('a drag stroke is one undo gesture, not one per cell', () => {
    const commits: Array<[number, number]> = [];
    s.selection.onCommit = (before, after) => commits.push([before.size, after.size]);

    tool.pointerDown({ col: 2, row: 2 }, pev());
    tool.pointerMove({ col: 3, row: 2 }, pev());
    tool.pointerMove({ col: 4, row: 2 }, pev());
    tool.pointerUp();
    expect(commits).toEqual([[0, 3]]);
  });

  it('a plain drag paints a fresh selection cell by cell', () => {
    tool.pointerDown({ col: 2, row: 2 }, pev());
    tool.pointerMove({ col: 3, row: 2 }, pev());
    tool.pointerMove({ col: 4, row: 2 }, pev());
    tool.pointerUp();
    expect(s.selection.size).toBe(3);
    expect(s.selection.has(4, 2)).toBe(true);
  });

  it('an Alt drag erases from the selection', () => {
    s.selection.apply([{ col: 2, row: 2 }, { col: 3, row: 2 }, { col: 4, row: 2 }], 'replace');
    tool.pointerDown({ col: 2, row: 2 }, pev({ altKey: true }));
    tool.pointerMove({ col: 3, row: 2 }, pev({ altKey: true }));
    tool.pointerUp();
    expect(s.selection.size).toBe(1);
    expect(s.selection.has(4, 2)).toBe(true);
  });

  it('a wider brush paints its whole footprint', () => {
    clickOption('#selection-brush-group .brush-btn[data-brush="1"]');
    tool.pointerDown({ col: 5, row: 5 }, pev());
    tool.pointerUp();
    expect(s.selection.size).toBe(7);
    expect(s.selection.has(5, 5)).toBe(true);
    expect(s.selection.has(4, 5)).toBe(true);
    expect(s.selection.has(6, 5)).toBe(true);
  });

  it('the brush footprint clips at the map border', () => {
    clickOption('#selection-brush-group .brush-btn[data-brush="1"]');
    tool.pointerDown({ col: 0, row: 0 }, pev());
    tool.pointerUp();
    expect(s.selection.has(0, 0)).toBe(true);
    expect(s.selection.size).toBeLessThan(7);
    for (const { col, row } of s.selection.cells()) {
      expect(s.map.inBounds(col, row)).toBe(true);
    }
  });

  it('brushRadius follows the brush only while in pointer mode', () => {
    clickOption('#selection-brush-group .brush-btn[data-brush="2"]');
    expect(tool.brushRadius()).toBe(2);
    clickOption('#selection-mode-group .brush-btn[data-select-mode="wand"]');
    expect(tool.brushRadius()).toBe(0);
    clickOption('#selection-mode-group .brush-btn[data-select-mode="pointer"]');
    expect(tool.brushRadius()).toBe(2);
  });
});

describe('magic wand', () => {
  it('contiguous terrain match stops at the region boundary', () => {
    s.map.setTerrain(2, 2, 1);
    s.map.setTerrain(8, 8, 1); // same terrain, different island
    clickOption('#selection-mode-group .brush-btn[data-select-mode="wand"]');
    tool.pointerDown({ col: 2, row: 2 }, pev());
    tool.pointerUp();
    expect(s.selection.has(2, 2)).toBe(true);
    expect(s.selection.has(8, 8)).toBe(false);
  });

  it('non-contiguous terrain match selects every matching cell map-wide', () => {
    s.map.setTerrain(2, 2, 1);
    s.map.setTerrain(8, 8, 1);
    clickOption('#selection-mode-group .brush-btn[data-select-mode="wand"]');
    setCheckbox('wand-contiguous', false);
    tool.pointerDown({ col: 2, row: 2 }, pev());
    tool.pointerUp();
    expect(s.selection.size).toBe(2);
    expect(s.selection.has(8, 8)).toBe(true);
  });

  it('elevation match honours the tolerance window', () => {
    s.map.setElevation(0, 0, 10);
    s.map.setElevation(0, 1, 12);
    s.map.setElevation(0, 2, 13); // just outside ±2
    clickOption('#selection-mode-group .brush-btn[data-select-mode="wand"]');
    clickOption('#wand-match-group .scatter-type-btn[data-wand-match="elevation"]');
    setCheckbox('wand-contiguous', false);

    const tolerance = document.getElementById('wand-tolerance') as HTMLInputElement;
    tolerance.value = '2';
    tolerance.dispatchEvent(new Event('input', { bubbles: true }));

    tool.pointerDown({ col: 0, row: 0 }, pev());
    tool.pointerUp();
    expect(s.selection.has(0, 0)).toBe(true);
    expect(s.selection.has(0, 1)).toBe(true);
    expect(s.selection.has(0, 2)).toBe(false);
    expect(s.selection.size).toBe(2);
  });
});

describe('wand hover preview', () => {
  const lastPreview = () => s.selectionPreviews[s.selectionPreviews.length - 1] as
    Array<{ col: number; row: number }> | null;

  it('hovering previews the would-be region without touching the selection', () => {
    s.map.setTerrain(2, 2, 1);
    s.map.setTerrain(3, 2, 1);
    clickOption('#selection-mode-group .brush-btn[data-select-mode="wand"]');
    tool.pointerMove({ col: 2, row: 2 }, pev());
    expect(s.selection.size).toBe(0);
    expect(lastPreview()?.length).toBe(2);
  });

  it('clicking commits the region and drops the preview', () => {
    s.map.setTerrain(2, 2, 1);
    clickOption('#selection-mode-group .brush-btn[data-select-mode="wand"]');
    tool.pointerMove({ col: 2, row: 2 }, pev());
    tool.pointerDown({ col: 2, row: 2 }, pev());
    tool.pointerUp();
    expect(s.selection.has(2, 2)).toBe(true);
    expect(lastPreview()).toBeNull();
  });

  it('changing a wand option rebuilds the preview under the cursor', () => {
    s.map.setTerrain(2, 2, 1);
    s.map.setTerrain(8, 8, 1); // disconnected twin
    s.hoveredCell = { col: 2, row: 2 };
    clickOption('#selection-mode-group .brush-btn[data-select-mode="wand"]');
    tool.pointerMove({ col: 2, row: 2 }, pev());
    expect(lastPreview()?.length).toBe(1);

    const chk = document.getElementById('wand-contiguous') as HTMLInputElement;
    chk.checked = false;
    chk.dispatchEvent(new Event('change', { bubbles: true }));
    expect(lastPreview()?.length).toBe(2); // map-wide now previews both islands
  });

  it('leaving the map or the wand mode hides the preview', () => {
    s.map.setTerrain(2, 2, 1);
    clickOption('#selection-mode-group .brush-btn[data-select-mode="wand"]');
    tool.pointerMove({ col: 2, row: 2 }, pev());
    tool.pointerMove(null, pev());
    expect(lastPreview()).toBeNull();

    tool.pointerMove({ col: 2, row: 2 }, pev());
    clickOption('#selection-mode-group .brush-btn[data-select-mode="pointer"]');
    expect(lastPreview()).toBeNull();
  });
});

describe('intersect gestures', () => {
  it('a Shift+Alt rectangle keeps only the overlap', () => {
    s.selection.apply([{ col: 1, row: 1 }, { col: 2, row: 1 }, { col: 8, row: 8 }], 'replace');
    clickOption('#selection-mode-group .brush-btn[data-select-mode="rect"]');
    tool.pointerDown({ col: 0, row: 0 }, pev({ shiftKey: true, altKey: true }));
    tool.pointerMove({ col: 3, row: 2 }, pev({ shiftKey: true, altKey: true }));
    tool.pointerUp();
    expect(s.selection.size).toBe(2);
    expect(s.selection.has(1, 1)).toBe(true);
    expect(s.selection.has(8, 8)).toBe(false);
  });

  it('a Shift+Alt pointer stroke buffers and intersects on release', () => {
    s.selection.apply([{ col: 2, row: 2 }, { col: 3, row: 2 }, { col: 8, row: 8 }], 'replace');
    tool.pointerDown({ col: 2, row: 2 }, pev({ shiftKey: true, altKey: true }));
    // Mid-stroke the selection is untouched — intersect commits at release.
    expect(s.selection.size).toBe(3);
    tool.pointerMove({ col: 3, row: 2 }, pev({ shiftKey: true, altKey: true }));
    tool.pointerMove({ col: 4, row: 2 }, pev({ shiftKey: true, altKey: true }));
    tool.pointerUp();
    expect(s.selection.size).toBe(2);
    expect(s.selection.has(8, 8)).toBe(false);
  });
});

describe('rectangle mode', () => {
  it('selects the dragged col/row box on release', () => {
    clickOption('#selection-mode-group .brush-btn[data-select-mode="rect"]');
    tool.pointerDown({ col: 1, row: 1 }, pev());
    tool.pointerMove({ col: 3, row: 2 }, pev());
    tool.pointerUp();
    expect(s.selection.size).toBe(6); // cols 1–3 × rows 1–2
    expect(s.selection.has(1, 1)).toBe(true);
    expect(s.selection.has(3, 2)).toBe(true);
  });
});

describe('keyboard', () => {
  it('Escape clears the selection', () => {
    s.selection.apply([{ col: 2, row: 2 }], 'replace');
    expect(tool.keyDown(new KeyboardEvent('keydown', { key: 'Escape' }))).toBe(true);
    expect(s.selection.size).toBe(0);
  });
});
