// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest';
import type { MapEdit } from '@loyalj/hex-world';
import { RiverTool } from '../src/tools/riverTool.ts';
import { clickOption, loadEditorDom, makeCtx, makeScene, pev, WATER } from './helpers.ts';
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
