// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest';
import type { MapEdit, TerrainDescriptor } from '@loyalj/hex-world';
import { ScatterTool } from '../src/tools/scatterTool.ts';
import { clickOption, countCells, loadEditorDom, makeCtx, makeScene, pev } from './helpers.ts';
import type { FakeScene } from './helpers.ts';

let s: FakeScene;
let tool: ScatterTool;
let edits: MapEdit[];

beforeEach(() => {
  loadEditorDom();
  s = makeScene();
  const made = makeCtx(s);
  edits = made.edits;
  tool = new ScatterTool(made.ctx);
});

const paint = (col: number, row: number): void => {
  tool.pointerDown({ col, row }, pev());
  tool.pointerUp();
};

describe('ScatterTool', () => {
  it('paints the default sparse density on the default layer', () => {
    paint(3, 3);
    expect(s.map.getFeatureLevel(3, 3, 0)).toBe(1);
    expect(edits.length).toBe(1);
  });

  it('density and layer buttons steer the write', () => {
    clickOption('#density-group .density-btn[data-density="3"]');
    clickOption('#scatter-type-group .scatter-type-btn[data-scatter-layer="2"]');
    paint(3, 3);
    expect(s.map.getFeatureLevel(3, 3, 2)).toBe(3);
    expect(s.map.getFeatureLevel(3, 3, 0)).toBe(0);
  });

  it('random density lands within 1–3', () => {
    clickOption('#density-group .density-btn[data-density="-1"]');
    paint(3, 3);
    const level = s.map.getFeatureLevel(3, 3, 0);
    expect(level).toBeGreaterThanOrEqual(1);
    expect(level).toBeLessThanOrEqual(3);
  });

  it('respects the elevation band', () => {
    const minEl = document.getElementById('scatter-elev-min') as HTMLInputElement;
    minEl.value = '2';
    minEl.dispatchEvent(new Event('input'));
    paint(3, 3); // elevation 0 < min 2
    expect(s.map.getFeatureLevel(3, 3, 0)).toBe(0);
    expect(edits.length).toBe(0);

    s.map.setElevation(4, 4, 5);
    paint(4, 4);
    expect(s.map.getFeatureLevel(4, 4, 0)).toBe(1);
  });

  it('respects the terrain filter chips', () => {
    tool.refreshTerrainFilter([
      { index: 0, id: 'grass', name: 'Grass', color: 0x00ff00 } as TerrainDescriptor,
      { index: 1, id: 'sand',  name: 'Sand',  color: 0xffff00 } as TerrainDescriptor,
    ]);
    // Activate the filter for terrain 1 only.
    document.querySelectorAll<HTMLButtonElement>('#scatter-terrain-filter .terrain-filter-btn')[1].click();

    s.map.setTerrain(4, 4, 1);
    paint(3, 3); // terrain 0 — filtered out
    paint(4, 4); // terrain 1 — allowed
    expect(s.map.getFeatureLevel(3, 3, 0)).toBe(0);
    expect(s.map.getFeatureLevel(4, 4, 0)).toBe(1);
  });

  it('fill covers the connected same-terrain region', () => {
    s.map.setTerrain(2, 2, 1);
    s.map.setTerrain(3, 2, 1);
    clickOption('#scatter-mode-group .scatter-type-btn[data-scatter-mode="fill"]');
    tool.pointerDown({ col: 2, row: 2 }, pev());

    expect(s.map.getFeatureLevel(2, 2, 0)).toBe(1);
    expect(s.map.getFeatureLevel(3, 2, 0)).toBe(1);
    expect(countCells(s.map, (c, r) => s.map.getFeatureLevel(c, r, 0) > 0)).toBe(2);
    expect(edits.length).toBe(1);
  });

  it('Alt+click samples the density under the cursor', () => {
    s.map.setFeatureLevel(6, 6, 0, 2);
    tool.pointerDown({ col: 6, row: 6 }, pev({ altKey: true }));
    tool.pointerUp();
    paint(1, 1);
    expect(s.map.getFeatureLevel(1, 1, 0)).toBe(2); // sampled medium, not the default sparse
  });
});
