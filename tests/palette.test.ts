// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest';
import { initPalette, EDITOR_DEFAULT_TERRAINS } from '../src/ui/palette.ts';
import { TerrainTool } from '../src/tools/terrainTool.ts';
import type { ScatterTool } from '../src/tools/scatterTool.ts';
import type { SceneApi } from '../src/scene.ts';
import { clickOption, loadEditorDom, makeCtx, makeScene, pev, WATER } from './helpers.ts';
import type { FakeScene } from './helpers.ts';

const SOLIDS  = EDITOR_DEFAULT_TERRAINS.filter(d => !d.liquidType);
const LIQUIDS = EDITOR_DEFAULT_TERRAINS.filter(d => d.liquidType);

let s: FakeScene;
let tool: TerrainTool;

const rows = () => [...document.querySelectorAll<HTMLElement>('#terrain-type-group .swatch-row')];
const activeRow = () => document.querySelector<HTMLElement>('#terrain-type-group .swatch-row.active');
const activeTab = () =>
  document.querySelector<HTMLElement>('#terrain-category-group .scatter-type-btn.active')!
    .dataset['terrainCat'];

beforeEach(() => {
  loadEditorDom();
  s = makeScene();
  tool = new TerrainTool(makeCtx(s).ctx);
  initPalette({
    scene: s as unknown as SceneApi,
    terrainTool: tool,
    scatterTool: { refreshTerrainFilter() {} } as unknown as ScatterTool,
    minimapInvalidate() {},
  });
});

describe('terrain palette tabs', () => {
  it('shows only solid swatches on the default tab', () => {
    expect(rows().map(r => r.dataset['terrain']))
      .toEqual(SOLIDS.map(d => String(d.index)));
  });

  it('the Liquid tab shows only liquid swatches', () => {
    clickOption('#terrain-category-group .scatter-type-btn[data-terrain-cat="liquid"]');
    expect(rows().map(r => r.dataset['terrain']))
      .toEqual(LIQUIDS.map(d => String(d.index)));
  });

  it('clicking a swatch selects it for painting', () => {
    rows()[2].click();
    expect(tool.paintTerrain).toBe(SOLIDS[2].index);
    expect(activeRow()?.dataset['terrain']).toBe(String(SOLIDS[2].index));
  });

  it('eyedropping a liquid switches to the Liquid tab and highlights it', () => {
    s.map.setTerrain(4, 4, WATER);
    tool.pointerDown({ col: 4, row: 4 }, pev({ altKey: true }));
    tool.pointerUp();

    expect(tool.paintTerrain).toBe(WATER);
    expect(activeTab()).toBe('liquid');
    expect(activeRow()?.dataset['terrain']).toBe(String(WATER));
  });

  it('liquid swatches carry no edit affordance', () => {
    clickOption('#terrain-category-group .scatter-type-btn[data-terrain-cat="liquid"]');
    for (const row of rows()) {
      expect(row.classList.contains('swatch-row--custom')).toBe(false);
      expect(row.title).not.toContain('right-click');
    }
  });
});
