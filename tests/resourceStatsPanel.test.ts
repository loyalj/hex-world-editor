// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest';
import type { SceneApi } from '../src/scene.ts';
import { cellsOfResource, countResources, initResourceStatsPanel } from '../src/ui/resourceStatsPanel.ts';
import { loadEditorDom, makeScene } from './helpers.ts';
import type { FakeScene } from './helpers.ts';

let s: FakeScene;
const rows = () => [...document.querySelectorAll<HTMLButtonElement>('#resource-stats-list .stat-row')];
const names = () => rows().map(r => r.querySelector('.stat-name')!.textContent);
const badge = () => document.getElementById('resource-stats-count')!.textContent;
const scene = () => s as unknown as SceneApi;

beforeEach(() => {
  loadEditorDom();
  s = makeScene(10, 10);
  s.resourceDescriptors = [
    { id: 'iron', name: 'Iron', color: 0x888888 },
    { id: 'gems', name: 'Gems', color: 0xff00ff },
    { id: 'salt', name: 'Salt', color: 0xffffff },
  ];
  s.resources = {
    resourceKey: 'resource',
    resourceAt: (c: number, r: number) => (s.map.getCellData(c, r, 'resource') as string | undefined) ?? null,
  };
  for (let col = 0; col < 6; col++) s.map.setCellData(col, 0, 'resource', 'gems'); // 6 gems
  for (let col = 0; col < 2; col++) s.map.setCellData(col, 1, 'resource', 'iron'); // 2 iron
  document.getElementById('resource-stats-panel')!.classList.remove('hidden');
});

describe('countResources / cellsOfResource', () => {
  it('count every placed cell by type', () => {
    const counts = countResources(scene());
    expect(counts.get('gems')).toBe(6);
    expect(counts.get('iron')).toBe(2);
    expect(counts.has('salt')).toBe(false);
    expect(cellsOfResource(scene(), 'iron')).toEqual([{ col: 0, row: 1 }, { col: 1, row: 1 }]);
  });

  it('are empty without a resource layer', () => {
    s.resources = null;
    expect(countResources(scene()).size).toBe(0);
    expect(cellsOfResource(scene(), 'iron')).toEqual([]);
  });
});

describe('Resources panel', () => {
  it('lists the roster most placed first, unused types last and disabled', () => {
    initResourceStatsPanel({ scene: scene() });
    expect(names()).toEqual(['Gems', 'Iron', 'Salt']);
    expect(rows()[0].querySelector('.stat-count')!.textContent).toBe('6');
    expect(rows()[2].disabled).toBe(true);
    expect(badge()).toBe('8 placed');
  });

  it('a row selects the cells holding the type with the modifier convention', () => {
    initResourceStatsPanel({ scene: scene() });
    rows()[1].click();
    expect(s.selection.size).toBe(2);
    rows()[0].dispatchEvent(new MouseEvent('click', { shiftKey: true }));
    expect(s.selection.size).toBe(8);
    rows()[1].dispatchEvent(new MouseEvent('click', { altKey: true }));
    expect(s.selection.size).toBe(6);
  });

  it('refresh recounts, and skips the work while hidden', () => {
    const panel = initResourceStatsPanel({ scene: scene() });
    s.map.setCellData(5, 5, 'resource', 'salt');
    panel.refresh();
    expect(rows()[2].disabled).toBe(false);
    expect(badge()).toBe('9 placed');
    document.getElementById('resource-stats-panel')!.classList.add('hidden');
    s.map.setCellData(6, 6, 'resource', 'salt');
    panel.refresh();
    expect(badge()).toBe('9 placed');
  });
});
