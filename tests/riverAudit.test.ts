// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest';
import { offsetNeighbor } from '@loyalj/hex-world';
import type { SceneApi } from '../src/scene.ts';
import { EDGE_DIRS } from '../src/tools/hexPath.ts';
import { initRiverAudit } from '../src/ui/riverAudit.ts';
import { loadEditorDom, makeScene, WATER } from './helpers.ts';
import type { FakeScene } from './helpers.ts';

let s: FakeScene;
let focused: Array<{ col: number; row: number }>;

function link(a: [number, number], b: [number, number]): void {
  for (let e = 0; e < 6; e++) {
    const nb = offsetNeighbor(a[0], a[1], EDGE_DIRS[e]);
    if (nb.col === b[0] && nb.row === b[1]) {
      s.map.setRiverOutgoing(a[0], a[1], e);
      s.map.setRiverIncoming(b[0], b[1], (e + 3) % 6);
      return;
    }
  }
}

beforeEach(() => {
  loadEditorDom();
  s = makeScene();
  focused = [];
  // happy-dom's dialog lacks showModal; the module only needs open/close.
  const dialog = document.getElementById('river-audit-dialog') as HTMLDialogElement;
  dialog.showModal = () => { dialog.setAttribute('open', ''); };
});

const rows = () => [...document.querySelectorAll<HTMLButtonElement>('#river-audit-list .audit-row')];
const groups = () => [...document.querySelectorAll<HTMLElement>('#river-audit-list .audit-group')].map(g => g.textContent);
const summary = () => document.getElementById('river-audit-summary')!.textContent;

describe('river audit dialog', () => {
  it('reports an empty map and a clean river', () => {
    const audit = initRiverAudit({ scene: s as unknown as SceneApi, focusCell: c => focused.push(c) });
    audit.open();
    expect(summary()).toBe('No rivers on the map.');
    for (let c = 2; c <= 6; c++) s.map.setElevation(c, 4, 8 - c);
    s.map.setTerrain(6, 4, WATER);
    for (let c = 2; c < 6; c++) link([c, 4], [c + 1, 4]);
    audit.open();
    expect(summary()).toBe('5 river cells, no problems found.');
    expect(rows()).toHaveLength(0);
  });

  it('groups problems by kind and a row jumps to the cell', () => {
    for (let c = 2; c < 6; c++) link([c, 4], [c + 1, 4]); // flat, ends on land, source at 0
    s.map.setElevation(4, 4, 3);
    const audit = initRiverAudit({ scene: s as unknown as SceneApi, focusCell: c => focused.push(c) });
    audit.open();
    expect(summary()).toMatch(/5 river cells · 3 problems/);
    expect(groups()).toEqual(['Flows uphill · 1', 'Ends on land · 1', 'Low source · 1']);
    const uphill = rows().find(r => r.dataset['kind'] === 'uphill')!;
    uphill.click();
    expect(focused).toEqual([{ col: 3, row: 4 }]);
    expect(s.selectionPreviews.at(-1)).toEqual([{ col: 3, row: 4 }]);
  });

  it('the source threshold re-runs the check', () => {
    for (let c = 2; c < 6; c++) link([c, 4], [c + 1, 4]);
    s.map.setTerrain(6, 4, WATER);
    const audit = initRiverAudit({ scene: s as unknown as SceneApi, focusCell: c => focused.push(c) });
    audit.open();
    expect(groups()).toEqual(['Low source · 1']);
    const min = document.getElementById('river-audit-min-source') as HTMLInputElement;
    min.value = '0';
    min.dispatchEvent(new Event('change'));
    expect(rows()).toHaveLength(0);
    expect(summary()).toContain('no problems');
  });
});
