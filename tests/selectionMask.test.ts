// @vitest-environment happy-dom
// The Model-2 contract: a non-empty selection masks every map-editing tool to
// its cells, and an empty selection constrains nothing. Selection state itself
// never enters the undo history — these tests only assert what the tools write.
import { beforeEach, describe, expect, it } from 'vitest';
import type { MapEdit } from '@loyalj/hex-world';
import { TerrainTool } from '../src/tools/terrainTool.ts';
import { RoadTool } from '../src/tools/roadTool.ts';
import { clickOption, countCells, loadEditorDom, makeCtx, makeScene, pev, setInput } from './helpers.ts';
import type { FakeScene } from './helpers.ts';
import type { ToolContext } from '../src/tools/tool.ts';

let s: FakeScene;
let ctx: ToolContext;
let edits: MapEdit[];

beforeEach(() => {
  loadEditorDom();
  s = makeScene();
  const made = makeCtx(s);
  ctx = made.ctx;
  edits = made.edits;
});

const select = (cells: Array<{ col: number; row: number }>) =>
  s.selection.apply(cells, 'replace');

describe('brush stamps under a selection mask', () => {
  it('writes only the selected cells of the footprint', () => {
    const tool = new TerrainTool(ctx);
    tool.paintTerrain = 1;
    select([{ col: 4, row: 4 }, { col: 5, row: 4 }]);

    setInput('terrain-brush-size', '2'); // 19 cells
    tool.pointerDown({ col: 4, row: 4 }, pev());
    tool.pointerUp();

    expect(s.map.getTerrain(4, 4)).toBe(1);
    expect(s.map.getTerrain(5, 4)).toBe(1);
    expect(countCells(s.map, (c, r) => s.map.getTerrain(c, r) === 1)).toBe(2);
  });

  it('constrains nothing while the selection is empty', () => {
    const tool = new TerrainTool(ctx);
    tool.paintTerrain = 1;
    tool.pointerDown({ col: 4, row: 4 }, pev());
    tool.pointerUp();
    expect(s.map.getTerrain(4, 4)).toBe(1);
  });

  it('a stroke entirely outside the mask commits no edit', () => {
    const tool = new TerrainTool(ctx);
    tool.paintTerrain = 1;
    select([{ col: 0, row: 0 }]);
    tool.pointerDown({ col: 6, row: 6 }, pev());
    tool.pointerUp();
    expect(s.map.getTerrain(6, 6)).toBe(0);
    expect(edits.length).toBe(0);
  });
});

describe('flood fill under a selection mask', () => {
  it('treats the mask boundary as a wall, not a filter', () => {
    // Selected: (2,2) and (2,4) — same terrain, but (2,3) between them is
    // outside the mask, so the flood must not tunnel through it.
    const tool = new TerrainTool(ctx);
    tool.paintTerrain = 1;
    select([{ col: 2, row: 2 }, { col: 2, row: 4 }]);
    clickOption('#terrain-mode-group .scatter-type-btn[data-terrain-mode="fill"]');

    tool.pointerDown({ col: 2, row: 2 }, pev());
    tool.pointerUp();

    expect(s.map.getTerrain(2, 2)).toBe(1);
    expect(s.map.getTerrain(2, 4)).toBe(0); // disconnected inside the mask
    expect(countCells(s.map, (c, r) => s.map.getTerrain(c, r) === 1)).toBe(1);
  });

  it('does nothing when the click lands outside the mask', () => {
    const tool = new TerrainTool(ctx);
    tool.paintTerrain = 1;
    select([{ col: 0, row: 0 }]);
    clickOption('#terrain-mode-group .scatter-type-btn[data-terrain-mode="fill"]');
    tool.pointerDown({ col: 6, row: 6 }, pev());
    tool.pointerUp();
    expect(edits.length).toBe(0);
  });
});

describe('edge tools under a selection mask', () => {
  it('roads land only on segments with both endpoints selected', () => {
    const tool = new RoadTool(ctx);
    clickOption('#road-mode-group .brush-btn[data-road-mode="straight"]');
    // Select the first three cells of the row the drag will cross.
    select([{ col: 2, row: 5 }, { col: 3, row: 5 }, { col: 4, row: 5 }]);

    tool.pointerDown({ col: 2, row: 5 }, pev());
    s.hoveredCell = { col: 8, row: 5 };
    tool.pointerMove({ col: 8, row: 5 }, pev());
    tool.pointerUp();

    expect(s.map.hasRoads(2, 5)).toBe(true);
    expect(s.map.hasRoads(4, 5)).toBe(true);
    // Beyond the mask the drag laid nothing down.
    expect(s.map.hasRoads(6, 5)).toBe(false);
    expect(s.map.hasRoads(8, 5)).toBe(false);
  });
});
