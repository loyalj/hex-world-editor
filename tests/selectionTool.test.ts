// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest';
import { SelectionTool } from '../src/tools/selectionTool.ts';
import { clickOption, loadEditorDom, makeCtx, makeScene, pev, setInput } from './helpers.ts';
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
    setInput('selection-brush-size', '1');
    tool.pointerDown({ col: 5, row: 5 }, pev());
    tool.pointerUp();
    expect(s.selection.size).toBe(7);
    expect(s.selection.has(5, 5)).toBe(true);
    expect(s.selection.has(4, 5)).toBe(true);
    expect(s.selection.has(6, 5)).toBe(true);
  });

  it('the brush footprint clips at the map border', () => {
    setInput('selection-brush-size', '1');
    tool.pointerDown({ col: 0, row: 0 }, pev());
    tool.pointerUp();
    expect(s.selection.has(0, 0)).toBe(true);
    expect(s.selection.size).toBeLessThan(7);
    for (const { col, row } of s.selection.cells()) {
      expect(s.map.inBounds(col, row)).toBe(true);
    }
  });

  it('ring selects only the outer band and the hover outline follows it', () => {
    setInput('selection-brush-size', '2');
    clickOption('#selection-shape-group .scatter-type-btn[data-brush-shape="ring"]');
    tool.pointerDown({ col: 6, row: 6 }, pev());
    tool.pointerUp();
    expect(s.selection.size).toBe(12);
    expect(s.selection.has(6, 6)).toBe(false);
    expect(tool.hoverFootprint({ col: 6, row: 6 })).toHaveLength(12);
    expect(tool.statusText()).toContain('ring 12');
  });

  it('spray rolls each cell against the density', () => {
    setInput('selection-brush-size', '1');
    clickOption('#selection-shape-group .scatter-type-btn[data-brush-shape="spray"]');
    setInput('selection-density', '50');
    let i = 0;
    const rolls = [0.1, 0.9, 0.1, 0.9, 0.1, 0.9, 0.1];
    (tool as unknown as { rng: () => number }).rng = () => rolls[i++ % rolls.length];
    tool.pointerDown({ col: 6, row: 6 }, pev());
    tool.pointerUp();
    expect(s.selection.size).toBe(4);
    expect(tool.statusText()).toContain('spray ~4 of 7');
  });

  it('the bracket keys step the size in pointer mode only', () => {
    expect(tool.keyDown(new KeyboardEvent('keydown', { key: ']' }))).toBe(true);
    expect(tool.brushRadius()).toBe(1);
    expect(document.getElementById('selection-brush-size-value')!.textContent).toBe('1 · 7 cells');
    clickOption('#selection-mode-group .brush-btn[data-select-mode="wand"]');
    expect(tool.keyDown(new KeyboardEvent('keydown', { key: ']' }))).toBe(false);
  });

  it('brushRadius follows the brush only while in pointer mode', () => {
    setInput('selection-brush-size', '2');
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

  const dragBox = (): void => {
    tool.pointerDown({ col: 1, row: 1 }, pev());
    tool.pointerMove({ col: 7, row: 7 }, pev());
    tool.pointerUp();
  };

  it('circle shape rounds off the box corners', () => {
    clickOption('#selection-mode-group .brush-btn[data-select-mode="rect"]');
    clickOption('#rect-shape-group .brush-btn[data-marquee-shape="circle"]');
    dragBox();
    expect(s.selection.size).toBe(37);
    expect(s.selection.has(4, 4)).toBe(true);  // centre
    expect(s.selection.has(1, 4)).toBe(true);  // edge midpoints stay
    expect(s.selection.has(4, 1)).toBe(true);
    expect(s.selection.has(1, 1)).toBe(false); // corners drop
    expect(s.selection.has(7, 7)).toBe(false);
  });

  it('hexagon shape is symmetric with smooth hex-line slants', () => {
    clickOption('#selection-mode-group .brush-btn[data-select-mode="rect"]');
    clickOption('#rect-shape-group .brush-btn[data-marquee-shape="hexagon"]');
    dragBox();
    // Single-cell vertices top and bottom, straight full-width middle band,
    // and mirrored slants — the hand-drawn hexagon for a 1:1 box.
    expect(s.selection.size).toBe(29);
    const widths = rowSpans();
    expect([1, 2, 3, 4, 5, 6, 7].map(r => widths.get(r))).toEqual([1, 3, 7, 7, 7, 3, 1]);
    expect(s.selection.has(4, 1)).toBe(true);  // top vertex
    expect(s.selection.has(1, 4)).toBe(true);  // straight sides
    expect(s.selection.has(7, 4)).toBe(true);
    expect(s.selection.has(1, 1)).toBe(false); // corners drop
    expect(s.selection.has(7, 7)).toBe(false);
  });

  /** Contiguous col span per row of the current selection, keyed by row. */
  const rowSpans = (): Map<number, number> => {
    const lo = new Map<number, number>();
    const hi = new Map<number, number>();
    for (const { col, row } of s.selection.cells()) {
      lo.set(row, Math.min(lo.get(row) ?? Infinity, col));
      hi.set(row, Math.max(hi.get(row) ?? -Infinity, col));
    }
    const widths = new Map<number, number>();
    for (const [row, l] of lo) widths.set(row, hi.get(row)! - l + 1);
    return widths;
  };

  it('a downward triangle drag points the apex south with smooth sides', () => {
    clickOption('#selection-mode-group .brush-btn[data-select-mode="rect"]');
    clickOption('#rect-shape-group .brush-btn[data-marquee-shape="triangle"]');
    dragBox(); // (1,1) → (7,7): base at the start row, apex at the far end
    // A 1:1 box is the grid's natural equilateral triangle: each row toward
    // the apex is exactly one cell narrower — hand-drawn-smooth sides.
    expect(s.selection.size).toBe(28);
    const widths = rowSpans();
    for (let row = 1; row <= 7; row++) expect(widths.get(row)).toBe(8 - row);
    expect(s.selection.has(4, 7)).toBe(true);  // apex on the bottom row
    expect(s.selection.has(1, 1)).toBe(true);  // base row is full width
    expect(s.selection.has(7, 1)).toBe(true);
  });

  it('an upward triangle drag points the apex north', () => {
    clickOption('#selection-mode-group .brush-btn[data-select-mode="rect"]');
    clickOption('#rect-shape-group .brush-btn[data-marquee-shape="triangle"]');
    tool.pointerDown({ col: 7, row: 7 }, pev());
    tool.pointerMove({ col: 1, row: 1 }, pev());
    tool.pointerUp();
    expect(s.selection.size).toBe(28);
    const widths = rowSpans();
    for (let row = 1; row <= 7; row++) expect(widths.get(row)).toBe(row);
    expect(s.selection.has(4, 1)).toBe(true);  // apex on the top row
    expect(s.selection.has(1, 7)).toBe(true);  // base row is full width
    expect(s.selection.has(7, 7)).toBe(true);
  });

  it('a mostly-eastward drag points the triangle east', () => {
    clickOption('#selection-mode-group .brush-btn[data-select-mode="rect"]');
    clickOption('#rect-shape-group .brush-btn[data-marquee-shape="triangle"]');
    tool.pointerDown({ col: 1, row: 2 }, pev());
    tool.pointerMove({ col: 7, row: 6 }, pev()); // Δcol 6 > Δrow 4
    tool.pointerUp();
    expect(s.selection.size).toBe(21);
    const widths = rowSpans();
    expect([2, 3, 4, 5, 6].map(r => widths.get(r))).toEqual([2, 5, 7, 5, 2]);
    expect(s.selection.has(7, 4)).toBe(true);  // apex centred on the far column
    expect(s.selection.has(1, 2)).toBe(true);  // base column spans the box
    expect(s.selection.has(1, 6)).toBe(true);
    expect(s.selection.has(7, 2)).toBe(false); // far corners drop
    expect(s.selection.has(7, 6)).toBe(false);
  });

  it('a mostly-westward drag points the triangle west', () => {
    clickOption('#selection-mode-group .brush-btn[data-select-mode="rect"]');
    clickOption('#rect-shape-group .brush-btn[data-marquee-shape="triangle"]');
    tool.pointerDown({ col: 7, row: 6 }, pev());
    tool.pointerMove({ col: 1, row: 2 }, pev());
    tool.pointerUp();
    const widths = rowSpans();
    expect(widths.get(4)).toBe(7);             // apex row runs base to tip
    expect(widths.get(2)).toBe(widths.get(6)); // vertically symmetric
    expect(widths.get(3)).toBe(widths.get(5));
    expect(s.selection.has(1, 4)).toBe(true);  // apex centred on the far column
    expect(s.selection.has(7, 2)).toBe(true);  // base column spans the box
    expect(s.selection.has(7, 6)).toBe(true);
    expect(s.selection.has(1, 2)).toBe(false); // far corners drop
    expect(s.selection.has(1, 6)).toBe(false);
  });

  it('a wide shallow eastward drag fills every row with one contiguous span', () => {
    clickOption('#selection-mode-group .brush-btn[data-select-mode="rect"]');
    clickOption('#rect-shape-group .brush-btn[data-marquee-shape="triangle"]');
    tool.pointerDown({ col: 0, row: 0 }, pev());
    tool.pointerMove({ col: 10, row: 4 }, pev()); // wide, shallow box → east
    tool.pointerUp();
    const widths = rowSpans();
    expect(widths.get(2)).toBe(11);            // apex row runs base to tip
    expect(s.selection.has(10, 2)).toBe(true); // apex
    expect(s.selection.has(10, 0)).toBe(false);
    expect(s.selection.has(10, 4)).toBe(false);
    let cells = 0;
    for (let row = 0; row <= 4; row++) {
      expect(s.selection.has(0, row)).toBe(true); // base column is unbroken
      cells += widths.get(row)!;
    }
    expect(cells).toBe(s.selection.size); // every row is a single span, no gaps
  });

  it('a tiny 2×2 circle still selects all four cells', () => {
    clickOption('#selection-mode-group .brush-btn[data-select-mode="rect"]');
    clickOption('#rect-shape-group .brush-btn[data-marquee-shape="circle"]');
    tool.pointerDown({ col: 2, row: 2 }, pev());
    tool.pointerMove({ col: 3, row: 3 }, pev());
    tool.pointerUp();
    expect(s.selection.size).toBe(4);
  });

  it('holding Ctrl mid-drag locks the box to 1:1', () => {
    clickOption('#selection-mode-group .brush-btn[data-select-mode="rect"]');
    tool.pointerDown({ col: 2, row: 2 }, pev());
    tool.pointerMove({ col: 7, row: 4 }, pev({ ctrlKey: true }));
    tool.pointerUp();
    expect(s.selection.size).toBe(36); // 6×6 square, not 6×3
    expect(s.selection.has(7, 7)).toBe(true);
  });

  it('releasing Ctrl mid-drag restores the free box', () => {
    clickOption('#selection-mode-group .brush-btn[data-select-mode="rect"]');
    tool.pointerDown({ col: 2, row: 2 }, pev());
    tool.pointerMove({ col: 7, row: 4 }, pev({ ctrlKey: true }));
    tool.pointerMove({ col: 7, row: 4 }, pev());
    tool.pointerUp();
    expect(s.selection.size).toBe(18); // back to the dragged 6×3
    expect(s.selection.has(7, 4)).toBe(true);
    expect(s.selection.has(7, 5)).toBe(false);
  });

  it('a Ctrl-locked box overhanging the map clips at the border', () => {
    clickOption('#selection-mode-group .brush-btn[data-select-mode="rect"]');
    tool.pointerDown({ col: 2, row: 2 }, pev());
    tool.pointerMove({ col: 0, row: 7 }, pev({ ctrlKey: true })); // square corner projects to col −3
    tool.pointerUp();
    expect(s.selection.size).toBe(18); // cols 0–2 × rows 2–7
    for (const { col, row } of s.selection.cells()) {
      expect(s.map.inBounds(col, row)).toBe(true);
    }
  });

  it('a Ctrl-locked triangle overhanging the map stays in bounds', () => {
    clickOption('#selection-mode-group .brush-btn[data-select-mode="rect"]');
    clickOption('#rect-shape-group .brush-btn[data-marquee-shape="triangle"]');
    tool.pointerDown({ col: 2, row: 2 }, pev());
    tool.pointerMove({ col: 0, row: 7 }, pev({ ctrlKey: true }));
    tool.pointerUp();
    expect(s.selection.size).toBeGreaterThan(0);
    for (const { col, row } of s.selection.cells()) {
      expect(s.map.inBounds(col, row)).toBe(true);
    }
  });

  it('the shape controls show only while in rect mode', () => {
    const section = document.getElementById('rect-shape-section') as HTMLElement;
    expect(section.classList.contains('hidden')).toBe(true);
    clickOption('#selection-mode-group .brush-btn[data-select-mode="rect"]');
    expect(section.classList.contains('hidden')).toBe(false);
    clickOption('#selection-mode-group .brush-btn[data-select-mode="pointer"]');
    expect(section.classList.contains('hidden')).toBe(true);
  });
});

describe('selection actions', () => {
  it('Border keeps only the outline of a filled region', () => {
    setInput('selection-brush-size', '2');
    tool.pointerDown({ col: 6, row: 6 }, pev());
    tool.pointerUp();
    expect(s.selection.size).toBe(19);
    (document.getElementById('selection-border-btn') as HTMLButtonElement).click();
    expect(s.selection.size).toBe(12);
    expect(s.selection.has(6, 6)).toBe(false);
    expect(s.selection.has(8, 6)).toBe(true);
  });

  it('Border of a full-map selection empties it — the map edge is a wall, not a boundary', () => {
    s.selection.selectAll(s.map.width, s.map.height);
    (document.getElementById('selection-border-btn') as HTMLButtonElement).click();
    expect(s.selection.size).toBe(0);
  });

  it('a stationary right click subtracts like Alt+click', () => {
    s.selection.apply([{ col: 2, row: 2 }, { col: 3, row: 2 }], 'replace');
    tool.rightClick({ col: 2, row: 2 }, pev());
    expect(s.selection.size).toBe(1);
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
