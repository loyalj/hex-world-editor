// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest';
import { TerritoryLayer } from '@loyalj/hex-world';
import type { MapEdit } from '@loyalj/hex-world';
import { TerritoryTool } from '../src/tools/territoryTool.ts';
import { loadEditorDom, makeCtx, makeScene, pev } from './helpers.ts';
import type { FakeScene } from './helpers.ts';

/**
 * The territory tool against the library's real TerritoryLayer rather than
 * the fake's two-method stand-in, so its owner lookup and metadata key are
 * the ones the editor really runs on. The layer only needs an overlay sink
 * to construct; nothing here draws.
 */
let s: FakeScene;
let edits: MapEdit[];
let tool: TerritoryTool;

beforeEach(() => {
  loadEditorDom();
  s = makeScene();
  const factions = [
    { id: 'red',  name: 'Red',  color: 0xff0000 },
    { id: 'blue', name: 'Blue', color: 0x0000ff },
  ];
  s.factions = factions;
  s.territory = new TerritoryLayer({
    overlays: { set() {}, hide() {} } as unknown as ConstructorParameters<typeof TerritoryLayer>[0]['overlays'],
    map: () => s.map,
    factions,
  });
  const made = makeCtx(s);
  edits = made.edits;
  tool = new TerritoryTool(made.ctx);
});

const owner = (c: number, r: number) => (s.territory as TerritoryLayer).ownerOf(c, r);
const owned = (id: string) => (s.territory as TerritoryLayer).ownedCells(id).length;

describe('TerritoryTool on the real TerritoryLayer', () => {
  it('brush claims read back through the layer', () => {
    tool.pointerDown({ col: 5, row: 5 }, pev());
    tool.pointerUp();
    expect(owner(5, 5)).toBe('red');
    expect(edits.length).toBe(1);
  });

  it('grow by one ring claims the six neighbours of a lone cell', () => {
    tool.pointerDown({ col: 5, row: 5 }, pev());
    tool.pointerUp();
    document.getElementById('territory-grow')!.click();
    expect(owned('red')).toBe(7);
    expect(edits.length).toBe(2);
    document.getElementById('territory-grow')!.click();
    expect(owned('red')).toBe(19);
  });

  it('a selection confines grow to its cells, and says so', () => {
    tool.pointerDown({ col: 5, row: 5 }, pev());
    tool.pointerUp();
    s.selection.apply([{ col: 5, row: 5 }], 'replace');
    document.getElementById('territory-grow')!.click();
    expect(owned('red')).toBe(1);
    expect(tool.statusText()).toContain('nothing to grow into');
    s.selection.clear();
    document.getElementById('territory-grow')!.click();
    expect(owned('red')).toBe(7);
    expect(tool.statusText()).toContain('grew by 6');
  });
});
