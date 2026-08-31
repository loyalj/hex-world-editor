import { describe, expect, it } from 'vitest';
import { SelectionModel, selectionOpFor } from '../src/selection.ts';
import { floodRegion } from '../src/tools/hexPath.ts';
import { CommandHistory } from '../src/undo/history.ts';
import { SelectionCommand } from '../src/undo/commands.ts';

const sorted = (cells: Array<{ col: number; row: number }>) =>
  [...cells].sort((a, b) => a.row - b.row || a.col - b.col);

describe('selectionOpFor', () => {
  it('maps modifiers to operations', () => {
    expect(selectionOpFor({ shiftKey: false, altKey: false })).toBe('replace');
    expect(selectionOpFor({ shiftKey: true,  altKey: false })).toBe('add');
    expect(selectionOpFor({ shiftKey: false, altKey: true  })).toBe('subtract');
    expect(selectionOpFor({ shiftKey: true,  altKey: true  })).toBe('intersect');
  });
});

describe('SelectionModel', () => {
  it('replace swaps the whole set', () => {
    const model = new SelectionModel(() => {});
    model.apply([{ col: 1, row: 1 }, { col: 2, row: 1 }], 'replace');
    model.apply([{ col: 5, row: 5 }], 'replace');
    expect(model.cells()).toEqual([{ col: 5, row: 5 }]);
  });

  it('add and subtract fold into the existing set', () => {
    const model = new SelectionModel(() => {});
    model.apply([{ col: 1, row: 1 }], 'replace');
    model.apply([{ col: 2, row: 1 }, { col: 3, row: 1 }], 'add');
    model.apply([{ col: 2, row: 1 }, { col: 9, row: 9 }], 'subtract');
    expect(sorted(model.cells())).toEqual([{ col: 1, row: 1 }, { col: 3, row: 1 }]);
    expect(model.has(3, 1)).toBe(true);
    expect(model.has(2, 1)).toBe(false);
  });

  it('intersect keeps only the overlap', () => {
    const model = new SelectionModel(() => {});
    model.apply([{ col: 1, row: 1 }, { col: 2, row: 1 }, { col: 3, row: 1 }], 'replace');
    model.apply([{ col: 2, row: 1 }, { col: 3, row: 1 }, { col: 9, row: 9 }], 'intersect');
    expect(sorted(model.cells())).toEqual([{ col: 2, row: 1 }, { col: 3, row: 1 }]);
  });

  it('intersect with a disjoint set empties the selection', () => {
    let fired = 0;
    const model = new SelectionModel(() => fired++);
    model.apply([{ col: 1, row: 1 }], 'replace');
    model.apply([{ col: 5, row: 5 }], 'intersect');
    expect(model.size).toBe(0);
    expect(fired).toBe(2);
    // And intersecting the (already empty) set again is a silent no-op.
    model.apply([{ col: 5, row: 5 }], 'intersect');
    expect(fired).toBe(2);
  });

  it('fires onChange only when the set actually changes', () => {
    let fired = 0;
    const model = new SelectionModel(() => fired++);
    model.apply([{ col: 1, row: 1 }], 'replace');
    expect(fired).toBe(1);
    model.apply([{ col: 1, row: 1 }], 'add');        // already there
    model.apply([{ col: 7, row: 7 }], 'subtract');   // never was there
    model.clear();
    model.clear();                                    // already empty
    expect(fired).toBe(2);
  });

  it('replacing with the same single cell still counts as a change', () => {
    // The set went empty and was refilled — cheap to report, awkward to elide.
    let fired = 0;
    const model = new SelectionModel(() => fired++);
    model.apply([{ col: 1, row: 1 }], 'replace');
    model.apply([{ col: 1, row: 1 }], 'replace');
    expect(fired).toBe(2);
  });
});

describe('whole-set operations', () => {
  it('selectAll covers the map; invert of that empties it', () => {
    const model = new SelectionModel(() => {});
    model.selectAll(4, 3);
    expect(model.size).toBe(12);
    model.invert(4, 3);
    expect(model.size).toBe(0);
  });

  it('inverting an empty selection selects everything', () => {
    const model = new SelectionModel(() => {});
    model.invert(4, 3);
    expect(model.size).toBe(12);
  });

  it('invert swaps membership cell for cell', () => {
    const model = new SelectionModel(() => {});
    model.apply([{ col: 1, row: 1 }], 'replace');
    model.invert(3, 2);
    expect(model.size).toBe(5);
    expect(model.has(1, 1)).toBe(false);
    expect(model.has(0, 0)).toBe(true);
  });

  it('grow adds exactly the neighbour ring; shrink removes it again', () => {
    const model = new SelectionModel(() => {});
    model.apply([{ col: 5, row: 5 }], 'replace');
    model.grow(12, 12);
    expect(model.size).toBe(7); // the cell plus its six hex neighbours
    model.shrink(12, 12);
    expect(model.size).toBe(1);
    expect(model.has(5, 5)).toBe(true);
  });

  it('shrink treats the map edge as a wall, so a full selection is stable', () => {
    const model = new SelectionModel(() => {});
    model.selectAll(5, 5);
    model.shrink(5, 5);
    expect(model.size).toBe(25);
  });

  it('grow clips to the map bounds', () => {
    const model = new SelectionModel(() => {});
    model.apply([{ col: 0, row: 0 }], 'replace');
    model.grow(2, 2);
    for (const { col, row } of model.cells()) {
      expect(col).toBeGreaterThanOrEqual(0);
      expect(col).toBeLessThan(2);
      expect(row).toBeGreaterThanOrEqual(0);
      expect(row).toBeLessThan(2);
    }
  });
});

describe('undo integration', () => {
  it('each standalone mutation commits once with before/after snapshots', () => {
    const commits: Array<[number, number]> = [];
    const model = new SelectionModel(() => {});
    model.onCommit = (before, after) => commits.push([before.size, after.size]);

    model.apply([{ col: 1, row: 1 }], 'replace');
    model.apply([{ col: 2, row: 1 }], 'add');
    model.clear();
    expect(commits).toEqual([[0, 1], [1, 2], [2, 0]]);
  });

  it('a begin/end gesture batches many applies into one commit', () => {
    const commits: Array<[number, number]> = [];
    const model = new SelectionModel(() => {});
    model.onCommit = (before, after) => commits.push([before.size, after.size]);

    model.beginGesture();
    model.apply([{ col: 1, row: 1 }], 'add');
    model.apply([{ col: 2, row: 1 }], 'add');
    model.apply([{ col: 3, row: 1 }], 'add');
    model.endGesture();
    expect(commits).toEqual([[0, 3]]);
  });

  it('a gesture that changed nothing commits nothing', () => {
    const commits: unknown[] = [];
    const model = new SelectionModel(() => {});
    model.onCommit = () => commits.push(1);

    model.beginGesture();
    model.endGesture();
    model.clear(); // already empty — silent no-op
    expect(commits).toEqual([]);
  });

  it('restoreKeys never re-commits, so undo/redo cannot spiral', () => {
    const commits: unknown[] = [];
    const model = new SelectionModel(() => {});
    model.onCommit = () => commits.push(1);

    model.apply([{ col: 1, row: 1 }], 'replace');
    expect(commits.length).toBe(1);
    model.restoreKeys(new Set());
    expect(commits.length).toBe(1);
    expect(model.size).toBe(0);
  });

  it('selection commands ride the shared history but not documentDepth', () => {
    const history = new CommandHistory();
    const model = new SelectionModel(() => {});
    model.onCommit = (before, after) =>
      history.commit(new SelectionCommand(keys => model.restoreKeys(keys), before, after));

    model.apply([{ col: 1, row: 1 }], 'replace');
    model.apply([{ col: 2, row: 1 }], 'add');
    expect(history.depth).toBe(2);
    expect(history.documentDepth).toBe(0); // transient — never "unsaved changes"

    history.undo();
    expect(model.has(2, 1)).toBe(false);
    expect(model.has(1, 1)).toBe(true);
    history.undo();
    expect(model.size).toBe(0);

    history.redo();
    expect(model.has(1, 1)).toBe(true);
    expect(history.depth).toBe(1); // the redo consumed cleanly — no new commits
  });
});

describe('floodRegion', () => {
  // A 5×4 grid where terrain 1 forms two islands separated by terrain 0.
  const terrain = [
    [1, 1, 0, 1, 1],
    [1, 0, 0, 0, 1],
    [0, 0, 0, 1, 1],
    [0, 0, 0, 0, 0],
  ];
  const matches = (col: number, row: number) => terrain[row][col] === 1;

  it('collects only the connected component of the start cell', () => {
    const region = floodRegion(5, 4, 0, 0, matches);
    // The north-west island: (0,0), (1,0), (0,1) — the eastern island is
    // separated by terrain-0 cells and must not leak in.
    expect(sorted(region)).toEqual([
      { col: 0, row: 0 }, { col: 1, row: 0 }, { col: 0, row: 1 },
    ].sort((a, b) => a.row - b.row || a.col - b.col));
    expect(region.some(c => c.col >= 3)).toBe(false);
  });

  it('always includes the start cell, even when it does not match', () => {
    const region = floodRegion(5, 4, 2, 2, matches);
    expect(region).toContainEqual({ col: 2, row: 2 });
  });

  it('never steps outside the map bounds', () => {
    const region = floodRegion(5, 4, 4, 0, () => true);
    expect(region.length).toBe(20);
    for (const { col, row } of region) {
      expect(col).toBeGreaterThanOrEqual(0);
      expect(col).toBeLessThan(5);
      expect(row).toBeGreaterThanOrEqual(0);
      expect(row).toBeLessThan(4);
    }
  });
});
