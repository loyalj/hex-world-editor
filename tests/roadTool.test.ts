// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest';
import { hexToOffset, offsetNeighbor } from '@loyalj/hex-world';
import type { HexCoord, MapEdit } from '@loyalj/hex-world';
import { EDGE_DIRS } from '../src/tools/hexPath.ts';
import { RoadTool } from '../src/tools/roadTool.ts';
import { clickOption, loadEditorDom, makeCtx, makeScene, pev } from './helpers.ts';
import type { FakeScene } from './helpers.ts';

let s: FakeScene;
let tool: RoadTool;
let edits: MapEdit[];

beforeEach(() => {
  loadEditorDom();
  s = makeScene();
  const made = makeCtx(s);
  edits = made.edits;
  tool = new RoadTool(made.ctx);
});

function drag(a: [number, number], b: [number, number], shiftKey = false): void {
  tool.pointerDown({ col: a[0], row: a[1] }, pev({ shiftKey }));
  s.hoveredCell = { col: b[0], row: b[1] };
  tool.pointerMove({ col: b[0], row: b[1] }, pev({ shiftKey }));
  tool.pointerUp();
  s.hoveredCell = null;
}

describe('RoadTool', () => {
  it('a straight drag lays road edges along the line', () => {
    clickOption('#road-mode-group .brush-btn[data-road-mode="straight"]');
    drag([2, 2], [6, 2]);
    for (let c = 2; c <= 6; c++) expect(s.map.hasRoads(c, 2)).toBe(true);
    expect(edits.length).toBe(1);

    edits[0].undo();
    for (let c = 2; c <= 6; c++) expect(s.map.hasRoads(c, 2)).toBe(false);
  });

  it('path mode reaches the target too', () => {
    drag([2, 2], [6, 2]);
    expect(s.map.hasRoads(2, 2)).toBe(true);
    expect(s.map.hasRoads(6, 2)).toBe(true);
  });

  it('Shift erases the dragged line', () => {
    clickOption('#road-mode-group .brush-btn[data-road-mode="straight"]');
    drag([2, 2], [6, 2]);
    drag([2, 2], [6, 2], true);
    for (let c = 2; c <= 6; c++) expect(s.map.hasRoads(c, 2)).toBe(false);
  });

  it('Escape cancels a drag without writing', () => {
    tool.pointerDown({ col: 2, row: 2 }, pev());
    s.hoveredCell = { col: 6, row: 2 };
    tool.pointerMove({ col: 6, row: 2 }, pev());
    expect(tool.keyDown!(new KeyboardEvent('keydown', { key: 'Escape' }))).toBe(true);
    tool.pointerUp();
    expect(edits.length).toBe(0);
    expect(s.map.hasRoads(4, 2)).toBe(false);
  });

  it('costOptions mirrors the checkboxes live', () => {
    const cb = document.getElementById('road-cost-elev') as HTMLInputElement;
    const before = tool.costOptions().elevation;
    expect(typeof before).toBe('boolean');
    cb.checked = !cb.checked;
    expect(tool.costOptions().elevation).toBe(!before);
  });
});

function clickCell(c: [number, number]): void {
  tool.pointerDown({ col: c[0], row: c[1] }, pev());
  tool.pointerUp();
}

describe('RoadTool waypoint mode', () => {
  beforeEach(() => {
    clickOption('#road-mode-group .brush-btn[data-road-mode="waypoint"]');
  });

  it('routes through every waypoint and commits on Enter as one edit', () => {
    clickCell([2, 2]);
    clickCell([6, 2]);
    clickCell([6, 6]);
    expect(tool.keyDown!(new KeyboardEvent('keydown', { key: 'Enter' }))).toBe(true);
    expect(s.map.hasRoads(2, 2)).toBe(true);
    expect(s.map.hasRoads(6, 2)).toBe(true);
    expect(s.map.hasRoads(6, 6)).toBe(true);
    expect(s.map.hasRoads(4, 2)).toBe(true); // an intermediate cell of the first leg
    expect(edits.length).toBe(1);

    edits[0].undo();
    expect(s.map.hasRoads(4, 2)).toBe(false);
  });

  it('double-click commits despite its duplicate final click', () => {
    clickCell([2, 2]);
    clickCell([6, 2]);
    clickCell([6, 2]); // the double-click's second press lands on the same cell
    tool.doubleClick();
    expect(s.map.hasRoads(2, 2)).toBe(true);
    expect(s.map.hasRoads(6, 2)).toBe(true);
    expect(edits.length).toBe(1);
  });

  it('Escape abandons placed waypoints without writing', () => {
    clickCell([2, 2]);
    clickCell([6, 2]);
    expect(tool.keyDown!(new KeyboardEvent('keydown', { key: 'Escape' }))).toBe(true);
    tool.doubleClick();
    expect(edits.length).toBe(0);
    expect(s.map.hasRoads(2, 2)).toBe(false);
  });
});

describe('RoadTool endpoint snapping', () => {
  beforeEach(() => {
    clickOption('#road-mode-group .brush-btn[data-road-mode="straight"]');
    drag([2, 2], [4, 2]); // termini at (2,2) and (4,2)
  });

  it('a drag started near a road terminus snaps its start onto it', () => {
    drag([6, 2], [8, 2]); // 2 cells from the (4,2) terminus
    expect(s.map.hasRoads(5, 2)).toBe(true); // the gap is bridged
    expect(s.map.hasRoads(8, 2)).toBe(true);
  });

  it('the snap toggle turns it off', () => {
    (document.getElementById('road-snap') as HTMLInputElement).checked = false;
    drag([6, 2], [8, 2]);
    expect(s.map.hasRoads(5, 2)).toBe(false);
    expect(s.map.hasRoads(6, 2)).toBe(true);
  });

  it('erase drags never snap their start', () => {
    // A placing press 2 cells from the terminus snaps: its preview starts at (4,2)…
    tool.pointerDown({ col: 6, row: 2 }, pev());
    let preview = s.previews.at(-1) as HexCoord[];
    expect(hexToOffset(preview[0])).toEqual({ col: 4, row: 2 });
    tool.keyDown!(new KeyboardEvent('keydown', { key: 'Escape' }));

    // …while a Shift-erase press at the same cell stays where it was pressed.
    tool.pointerDown({ col: 6, row: 2 }, pev({ shiftKey: true }));
    preview = s.previews.at(-1) as HexCoord[];
    expect(hexToOffset(preview[0])).toEqual({ col: 6, row: 2 });
    tool.pointerUp();
  });
});

describe('RoadTool erase mode', () => {
  beforeEach(() => {
    clickOption('#road-mode-group .brush-btn[data-road-mode="straight"]');
    drag([2, 2], [6, 2]);
    clickOption('#road-mode-group .brush-btn[data-road-mode="erase"]');
  });

  it('a drag strips roads from the crossed cells as one edit', () => {
    tool.pointerDown({ col: 3, row: 2 }, pev());
    tool.pointerMove({ col: 4, row: 2 }, pev());
    tool.pointerUp();
    expect(s.map.hasRoads(3, 2)).toBe(false);
    expect(s.map.hasRoads(4, 2)).toBe(false);
    expect(s.map.hasRoads(2, 2)).toBe(false); // its only edge led into (3,2)
    expect(s.map.hasRoads(5, 2)).toBe(true);  // still joined to (6,2)
    expect(edits.length).toBe(2); // the setup drag, then one erase stroke

    edits[1].undo();
    expect(s.map.hasRoads(3, 2)).toBe(true);
    expect(s.map.hasRoads(2, 2)).toBe(true);
  });

  it('edges into unselected cells survive an erase', () => {
    s.selection.setCells([{ col: 2, row: 2 }, { col: 3, row: 2 }]);
    tool.pointerDown({ col: 3, row: 2 }, pev());
    tool.pointerUp();
    expect(s.map.hasRoads(2, 2)).toBe(false); // edge (2,2)–(3,2): both selected
    expect(s.map.hasRoads(3, 2)).toBe(true);  // edge (3,2)–(4,2) kept: (4,2) unselected
    expect(s.map.hasRoads(4, 2)).toBe(true);
  });

  it('clicking a bare cell commits nothing', () => {
    tool.pointerDown({ col: 9, row: 9 }, pev());
    tool.pointerUp();
    expect(edits.length).toBe(1); // just the setup drag
  });
});

describe('RoadTool single-edge mode', () => {
  beforeEach(() => {
    clickOption('#road-mode-group .brush-btn[data-road-mode="edge"]');
  });

  it('clicking toggles one edge on and off as separate undoable edits', () => {
    s.pickEdgeResult = { col: 3, row: 3, edge: 0 };
    tool.pointerDown({ col: 3, row: 3 }, pev());
    expect(s.map.hasRoadThroughEdge(3, 3, 0)).toBe(true);
    tool.pointerDown({ col: 3, row: 3 }, pev());
    expect(s.map.hasRoadThroughEdge(3, 3, 0)).toBe(false);
    expect(edits.length).toBe(2);

    edits[1].undo();
    expect(s.map.hasRoadThroughEdge(3, 3, 0)).toBe(true);
  });

  it('an edge whose neighbour is outside the selection is masked', () => {
    s.selection.setCells([{ col: 3, row: 3 }]);
    s.pickEdgeResult = { col: 3, row: 3, edge: 0 };
    tool.pointerDown({ col: 3, row: 3 }, pev());
    expect(edits.length).toBe(0);
    expect(s.map.hasRoadThroughEdge(3, 3, 0)).toBe(false);
  });

  it('boundary edges (neighbour off-map) are rejected', () => {
    let boundaryEdge = -1;
    for (let e = 0; e < 6; e++) {
      const nb = offsetNeighbor(0, 0, EDGE_DIRS[e]);
      if (!s.map.inBounds(nb.col, nb.row)) { boundaryEdge = e; break; }
    }
    expect(boundaryEdge).toBeGreaterThanOrEqual(0);
    s.pickEdgeResult = { col: 0, row: 0, edge: boundaryEdge };
    tool.pointerDown({ col: 0, row: 0 }, pev());
    expect(edits.length).toBe(0);
  });
});
