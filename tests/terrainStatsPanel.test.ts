// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest';
import type { SceneApi } from '../src/scene.ts';
import { cellsOfTerrain, countTerrains, initTerrainStatsPanel } from '../src/ui/terrainStatsPanel.ts';
import { loadEditorDom, makeScene, WATER } from './helpers.ts';
import type { FakeScene } from './helpers.ts';

const TERRAINS = [
  { index: 0,     id: 'grass', name: 'Grassland', color: 0x55aa33, texture: { type: 'procedural' as const } },
  { index: 1,     id: 'sand',  name: 'Sand',      color: 0xddcc88, texture: { type: 'procedural' as const } },
  { index: WATER, id: 'water', name: 'Water',     color: 0x3366cc, texture: { type: 'procedural' as const }, liquidType: 'water' },
  { index: 9,     id: 'ash',   name: 'Ash',       color: 0x444444, texture: { type: 'procedural' as const } },
];

let s: FakeScene;
const rows = () => [...document.querySelectorAll<HTMLButtonElement>('#terrains-list .stat-row')];
const names = () => rows().map(r => r.querySelector('.stat-name')!.textContent);

beforeEach(() => {
  loadEditorDom();
  s = makeScene(10, 10);
  for (let col = 0; col < 10; col++) s.map.setTerrain(col, 0, 1);      // 10 sand
  for (let col = 0; col < 3; col++) s.map.setTerrain(col, 1, WATER);   // 3 water
  document.getElementById('terrains-panel')!.classList.remove('hidden');
});

describe('countTerrains / cellsOfTerrain', () => {
  it('count every cell by terrain', () => {
    const counts = countTerrains(s.map);
    expect(counts.get(0)).toBe(87);
    expect(counts.get(1)).toBe(10);
    expect(counts.get(WATER)).toBe(3);
    expect(cellsOfTerrain(s.map, WATER)).toEqual([{ col: 0, row: 1 }, { col: 1, row: 1 }, { col: 2, row: 1 }]);
  });
});

describe('Terrains panel', () => {
  it('lists the roster most common first, unused terrains last and disabled', () => {
    initTerrainStatsPanel({ scene: s as unknown as SceneApi, terrains: () => TERRAINS });
    expect(names()).toEqual(['Grassland', 'Sand', 'Water', 'Ash']);
    expect(rows()[0].querySelector('.stat-count')!.textContent).toBe('87 · 87%');
    expect(rows()[2].querySelector('.stat-count')!.textContent).toBe('3 · 3%');
    expect(rows()[3].disabled).toBe(true);
    expect(rows()[3].classList.contains('stat-row--empty')).toBe(true);
    expect(document.getElementById('terrains-count')!.textContent).toBe('3 of 4');
  });

  it('a click selects every cell of that terrain; Shift adds; Alt removes', () => {
    initTerrainStatsPanel({ scene: s as unknown as SceneApi, terrains: () => TERRAINS });
    rows()[1].click(); // Sand
    expect(s.selection.size).toBe(10);
    expect(s.selection.has(5, 0)).toBe(true);
    rows()[2].dispatchEvent(new MouseEvent('click', { shiftKey: true })); // + Water
    expect(s.selection.size).toBe(13);
    rows()[1].dispatchEvent(new MouseEvent('click', { altKey: true }));   // − Sand
    expect(s.selection.size).toBe(3);
    expect(s.selection.has(0, 1)).toBe(true);
  });

  it('shows shares under one percent as "<1"', () => {
    s.map.setTerrain(9, 9, 9); // one ash cell in a hundred → 1%; make it a thousand-cell map instead
    const big = makeScene(40, 25);
    big.map.setTerrain(0, 0, 9);
    initTerrainStatsPanel({ scene: big as unknown as SceneApi, terrains: () => TERRAINS });
    const ash = rows().find(r => r.querySelector('.stat-name')!.textContent === 'Ash')!;
    expect(ash.querySelector('.stat-count')!.textContent).toBe('1 · <1%');
  });

  it('refresh recounts after edits, and skips the work while hidden', () => {
    const api = initTerrainStatsPanel({ scene: s as unknown as SceneApi, terrains: () => TERRAINS });
    s.map.setTerrain(5, 5, 9);
    api.refresh();
    expect(names()[2]).toBe('Water');
    expect(rows()[3].disabled).toBe(false);
    expect(rows()[3].querySelector('.stat-count')!.textContent).toBe('1 · 1%');

    const panel = document.getElementById('terrains-panel')!;
    panel.classList.add('hidden');
    s.map.setTerrain(6, 5, 9);
    api.refresh();
    expect(rows()[3].querySelector('.stat-count')!.textContent).toBe('1 · 1%'); // stale: hidden
    panel.classList.remove('hidden');
    api.refresh();
    expect(rows()[3].querySelector('.stat-count')!.textContent).toBe('2 · 2%');
  });

  it('paints a chip with the terrain thumbnail when one is available', () => {
    initTerrainStatsPanel({
      scene: s as unknown as SceneApi,
      terrains: () => TERRAINS,
      previewFor: index => (index === 1 ? 'data:image/png;base64,AAAA' : null),
    });
    const chips = rows().map(r => r.querySelector<HTMLElement>('.swatch-chip')!);
    expect(chips[1].style.backgroundImage).toContain('data:image/png;base64,AAAA');
    expect(chips[0].style.backgroundImage).not.toContain('data:');
  });
});
