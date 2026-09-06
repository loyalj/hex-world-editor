// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest';
import { POINTY_TOP, offsetNeighbor } from '@loyalj/hex-world';
import type { SceneApi } from '../src/scene.ts';
import { EDGE_DIRS } from '../src/tools/hexPath.ts';
import { initRoadAudit } from '../src/ui/roadAudit.ts';
import { loadEditorDom, makeScene, WATER } from './helpers.ts';
import type { FakeScene } from './helpers.ts';

let s: FakeScene;
let focused: Array<{ col: number; row: number }>;

/** Lay a road along row `row` from colA to colB, both half-edges of every hop. */
function road(row: number, colA: number, colB: number): void {
  for (let c = colA; c < colB; c++) {
    const e = EDGE_DIRS.findIndex(d => {
      const nb = offsetNeighbor(c, row, d);
      return nb.col === c + 1 && nb.row === row;
    });
    s.map.setRoadEdge(c, row, e, true, POINTY_TOP);
  }
}

beforeEach(() => {
  loadEditorDom();
  s = makeScene();
  focused = [];
  // happy-dom's dialog lacks showModal; the module only needs open/close.
  const dialog = document.getElementById('road-audit-dialog') as HTMLDialogElement;
  dialog.showModal = () => { dialog.setAttribute('open', ''); };
});

const rows = () => [...document.querySelectorAll<HTMLButtonElement>('#road-audit-list .audit-row')];
const groups = () => [...document.querySelectorAll<HTMLElement>('#road-audit-list .audit-group')].map(g => g.textContent);
const summary = () => document.getElementById('road-audit-summary')!.textContent;

describe('road audit dialog', () => {
  it('reports an empty map and a clean road', () => {
    const audit = initRoadAudit({ scene: s as unknown as SceneApi, focusCell: c => focused.push(c) });
    audit.open();
    expect(summary()).toBe('No roads on the map.');
    road(4, 2, 6);
    audit.open();
    expect(summary()).toBe('5 road cells, no problems found.');
    expect(rows()).toHaveLength(0);
  });

  it('groups problems by kind and a row jumps to the cell', () => {
    road(4, 2, 6);
    s.map.setTerrain(4, 4, WATER);   // the road runs through a lake
    s.map.setRoad(8, 8, 0, true);    // an unanswered half-edge, alone
    const audit = initRoadAudit({ scene: s as unknown as SceneApi, focusCell: c => focused.push(c) });
    audit.open();
    expect(summary()).toMatch(/6 road cells · 3 problems/);
    expect(groups()).toEqual(['Dangling edge · 1', 'Crosses water · 1', 'Isolated fragment · 1']);
    const water = rows().find(r => r.dataset['kind'] === 'water')!;
    water.click();
    expect(focused).toEqual([{ col: 4, row: 4 }]);
    expect(s.selectionPreviews.at(-1)).toEqual([{ col: 4, row: 4 }]);
  });

  it('the length threshold re-runs the check', () => {
    road(8, 1, 3); // a three-cell road: a fragment only below 4
    const audit = initRoadAudit({ scene: s as unknown as SceneApi, focusCell: c => focused.push(c) });
    audit.open();
    expect(summary()).toContain('no problems');
    const threshold = document.getElementById('road-audit-threshold') as HTMLInputElement;
    threshold.value = '4';
    threshold.dispatchEvent(new Event('change'));
    expect(groups()).toEqual(['Isolated fragment · 1']);
    expect(rows()[0].textContent).toContain('network of 3 cells');
  });
});
