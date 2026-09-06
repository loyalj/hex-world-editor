// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest';
import type { SceneApi } from '../src/scene.ts';
import { cellsOfFaction, countHoldings, initTerritoryStatsPanel } from '../src/ui/territoryStatsPanel.ts';
import { loadEditorDom, makeScene } from './helpers.ts';
import type { FakeScene } from './helpers.ts';

let s: FakeScene;
const rows = () => [...document.querySelectorAll<HTMLButtonElement>('#holdings-list .stat-row')];
const names = () => rows().map(r => r.querySelector('.stat-name')!.textContent);
const badge = () => document.getElementById('holdings-count')!.textContent;
const scene = () => s as unknown as SceneApi;

beforeEach(() => {
  loadEditorDom();
  s = makeScene(10, 10);
  s.factions = [
    { id: 'red',   name: 'Red',   color: 0xff0000 },
    { id: 'blue',  name: 'Blue',  color: 0x0000ff },
    { id: 'green', name: 'Green', color: 0x00ff00 },
  ];
  s.territory = {
    ownerKey: 'owner',
    ownerOf: (c: number, r: number) => (s.map.getCellData(c, r, 'owner') as string | undefined) ?? null,
  };
  for (let col = 0; col < 10; col++) s.map.setCellData(col, 0, 'owner', 'blue'); // 10 blue
  for (let col = 0; col < 3; col++)  s.map.setCellData(col, 1, 'owner', 'red');  // 3 red
  document.getElementById('holdings-panel')!.classList.remove('hidden');
});

describe('countHoldings / cellsOfFaction', () => {
  it('count every held cell by faction', () => {
    const counts = countHoldings(scene());
    expect(counts.get('blue')).toBe(10);
    expect(counts.get('red')).toBe(3);
    expect(counts.has('green')).toBe(false);
    expect(cellsOfFaction(scene(), 'red')).toEqual([{ col: 0, row: 1 }, { col: 1, row: 1 }, { col: 2, row: 1 }]);
  });

  it('are empty without a territory layer', () => {
    s.territory = null;
    expect(countHoldings(scene()).size).toBe(0);
    expect(cellsOfFaction(scene(), 'red')).toEqual([]);
  });
});

describe('Holdings panel', () => {
  it('lists the roster largest holding first, empty factions last and disabled', () => {
    initTerritoryStatsPanel({ scene: scene() });
    expect(names()).toEqual(['Blue', 'Red', 'Green']);
    expect(rows()[0].querySelector('.stat-count')!.textContent).toBe('10 · 10%');
    expect(rows()[1].querySelector('.stat-count')!.textContent).toBe('3 · 3%');
    expect(rows()[2].disabled).toBe(true);
    expect(rows()[2].classList.contains('stat-row--empty')).toBe(true);
    expect(badge()).toBe('13% claimed');
  });

  it('a row selects the faction\'s cells with the modifier convention', () => {
    initTerritoryStatsPanel({ scene: scene() });
    rows()[1].click();
    expect(s.selection.size).toBe(3);
    expect(s.selection.has(2, 1)).toBe(true);
    rows()[0].dispatchEvent(new MouseEvent('click', { shiftKey: true }));
    expect(s.selection.size).toBe(13);
    rows()[1].dispatchEvent(new MouseEvent('click', { altKey: true }));
    expect(s.selection.size).toBe(10);
  });

  it('refresh recounts, and skips the work while hidden', () => {
    const panel = initTerritoryStatsPanel({ scene: scene() });
    s.map.setCellData(5, 5, 'owner', 'green');
    panel.refresh();
    expect(names()).toEqual(['Blue', 'Red', 'Green']);
    expect(rows()[2].disabled).toBe(false);
    expect(badge()).toBe('14% claimed');

    document.getElementById('holdings-panel')!.classList.add('hidden');
    s.map.setCellData(6, 6, 'owner', 'green');
    panel.refresh();
    expect(badge()).toBe('14% claimed'); // stale on purpose
    document.getElementById('holdings-panel')!.classList.remove('hidden');
    panel.refresh();
    expect(badge()).toBe('15% claimed');
  });
});
