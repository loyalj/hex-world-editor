// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest';
import type { MapEdit } from '@loyalj/hex-world';
import { UnitTool } from '../src/tools/unitTool.ts';
import { UNIT_KEY, unitAt } from '../src/unitTypes.ts';
import { clickOption, loadEditorDom, makeCtx, makeScene, pev, WATER } from './helpers.ts';
import type { FakeScene } from './helpers.ts';

let s: FakeScene;
let tool: UnitTool;
let edits: MapEdit[];

beforeEach(() => {
  loadEditorDom();
  s = makeScene();
  s.factions = [
    { id: 'red',  name: 'Red',  color: 0xff0000 },
    { id: 'blue', name: 'Blue', color: 0x0000ff },
  ];
  const made = makeCtx(s);
  edits = made.edits;
  tool = new UnitTool(made.ctx);
});

function clickCell(col: number, row: number): void {
  tool.pointerDown({ col, row }, pev());
  tool.pointerUp();
}

describe('UnitTool', () => {
  it('places the selected type for the selected faction, undoably', () => {
    clickCell(2, 2);
    expect(unitAt(s.map, 2, 2)).toEqual({ type: 'infantry', faction: 'red' });
    expect(edits.length).toBe(1);
    expect(s.gameplayRefreshes).toBeGreaterThan(0);

    edits[0].undo();
    expect(unitAt(s.map, 2, 2)).toBeNull();
  });

  it('the type and faction palettes pick what gets placed', () => {
    document.querySelectorAll<HTMLButtonElement>('#unit-type-group .swatch-row')[1].click();
    document.querySelectorAll<HTMLButtonElement>('#unit-faction-group .swatch-row')[1].click();
    clickCell(3, 3);
    expect(unitAt(s.map, 3, 3)).toEqual({ type: 'cavalry', faction: 'blue' });
  });

  it('land units refuse water and ships refuse land', () => {
    s.map.setTerrain(5, 5, WATER);
    clickCell(5, 5); // infantry onto water
    expect(unitAt(s.map, 5, 5)).toBeNull();

    const shipChip = [...document.querySelectorAll<HTMLButtonElement>('#unit-type-group .swatch-row')]
      .find(b => b.dataset['id'] === 'ship')!;
    shipChip.click();
    clickCell(4, 4); // ship onto land
    expect(unitAt(s.map, 4, 4)).toBeNull();
    clickCell(5, 5); // ship onto water
    expect(unitAt(s.map, 5, 5)).toEqual({ type: 'ship', faction: 'red' });
  });

  it('erase mode removes a unit; empty cells commit nothing', () => {
    clickCell(2, 2);
    clickOption('#unit-mode-group .scatter-type-btn[data-unit-mode="erase"]');
    clickCell(3, 3); // nothing there
    expect(edits.length).toBe(1);
    clickCell(2, 2);
    expect(unitAt(s.map, 2, 2)).toBeNull();
    expect(edits.length).toBe(2);
  });

  it('the selection mask confines placement', () => {
    s.selection.setCells([{ col: 2, row: 2 }]);
    clickCell(2, 2);
    clickCell(3, 3);
    expect(unitAt(s.map, 2, 2)).not.toBeNull();
    expect(unitAt(s.map, 3, 3)).toBeNull();
  });

  it('Clear all removes every unit as one undoable edit', () => {
    clickCell(2, 2);
    clickCell(3, 3);
    (document.getElementById('unit-clear-all') as HTMLButtonElement).click();
    expect(unitAt(s.map, 2, 2)).toBeNull();
    expect(unitAt(s.map, 3, 3)).toBeNull();
    expect(edits.length).toBe(3);

    edits[2].undo();
    expect(s.map.getCellData(2, 2, UNIT_KEY)).toEqual({ type: 'infantry', faction: 'red' });
  });

  it('refreshPalette drops a deleted faction back to the first', () => {
    document.querySelectorAll<HTMLButtonElement>('#unit-faction-group .swatch-row')[1].click();
    s.factions = [{ id: 'red', name: 'Red', color: 0xff0000 }];
    tool.refreshPalette();
    clickCell(6, 6);
    expect(unitAt(s.map, 6, 6)).toEqual({ type: 'infantry', faction: 'red' });
  });
});
