// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest';
import type { MapEdit } from '@loyalj/hex-world';
import { TerritoryTool } from '../src/tools/territoryTool.ts';
import { ResourceTool } from '../src/tools/resourceTool.ts';
import { FogTool } from '../src/tools/fogTool.ts';
import { clickOption, loadEditorDom, makeCtx, makeScene, pev, WATER } from './helpers.ts';
import type { FakeScene } from './helpers.ts';
import type { ToolContext } from '../src/tools/tool.ts';

let s: FakeScene;
let ctx: ToolContext;
let edits: MapEdit[];
let settingsChanges: () => number;

beforeEach(() => {
  loadEditorDom();
  s = makeScene();
  const made = makeCtx(s);
  ctx = made.ctx;
  edits = made.edits;
  settingsChanges = made.settingsChanges;
});

// ---- Territory ----

function withTerritory(): TerritoryTool {
  s.factions = [
    { id: 'red',  name: 'Red',  color: 0xff0000 },
    { id: 'blue', name: 'Blue', color: 0x0000ff },
  ];
  s.territory = {
    ownerKey: 'owner',
    ownerOf: (c: number, r: number) => (s.map.getCellData(c, r, 'owner') as string | undefined) ?? null,
  };
  return new TerritoryTool(ctx);
}

const owner = (c: number, r: number) => s.map.getCellData(c, r, 'owner');

describe('TerritoryTool', () => {
  it('claims cells for the selected faction, undoably', () => {
    const tool = withTerritory();
    tool.pointerDown({ col: 2, row: 2 }, pev());
    tool.pointerUp();
    expect(owner(2, 2)).toBe('red');
    expect(edits.length).toBe(1);
    expect(s.gameplayRefreshes).toBeGreaterThan(0);

    edits[0].undo();
    expect(owner(2, 2)).toBeUndefined();
  });

  it('the faction palette picks the paint faction', () => {
    const tool = withTerritory();
    document.querySelectorAll<HTMLButtonElement>('#faction-group .swatch-row')[1].click();
    tool.pointerDown({ col: 3, row: 3 }, pev());
    tool.pointerUp();
    expect(owner(3, 3)).toBe('blue');
  });

  it('release mode clears ownership', () => {
    const tool = withTerritory();
    tool.pointerDown({ col: 2, row: 2 }, pev());
    tool.pointerUp();
    clickOption('#territory-mode-group .scatter-type-btn[data-territory-mode="release"]');
    tool.pointerDown({ col: 2, row: 2 }, pev());
    tool.pointerUp();
    expect(owner(2, 2)).toBeUndefined();
  });

  it('clear-all wipes every owner as one edit', () => {
    const tool = withTerritory();
    tool.pointerDown({ col: 2, row: 2 }, pev());
    tool.pointerUp();
    tool.pointerDown({ col: 5, row: 5 }, pev());
    tool.pointerUp();
    document.getElementById('territory-clear-all')!.click();
    expect(owner(2, 2)).toBeUndefined();
    expect(owner(5, 5)).toBeUndefined();
    expect(edits.length).toBe(3);
  });
});

// ---- Resources ----

function withResources(): ResourceTool {
  const descs = [
    { id: 'iron', name: 'Iron', color: 0x888888, placement: { minElevation: 2 } },
    { id: 'gems', name: 'Gems', color: 0xff00ff }, // no rule
  ];
  s.resourceDescriptors = descs;
  s.resources = {
    resourceKey: 'resource',
    resourceAt: (c: number, r: number) => (s.map.getCellData(c, r, 'resource') as string | undefined) ?? null,
    getDescriptor: (id: string) => descs.find(d => d.id === id),
  };
  return new ResourceTool(ctx);
}

const resource = (c: number, r: number) => s.map.getCellData(c, r, 'resource');

describe('ResourceTool', () => {
  it('placement rules gate the brush', () => {
    const tool = withResources(); // first descriptor (iron, minElevation 2) selected
    tool.pointerDown({ col: 2, row: 2 }, pev()); // elevation 0 — blocked
    tool.pointerUp();
    expect(resource(2, 2)).toBeUndefined();
    expect(edits.length).toBe(0);

    s.map.setElevation(3, 3, 4);
    tool.pointerDown({ col: 3, row: 3 }, pev());
    tool.pointerUp();
    expect(resource(3, 3)).toBe('iron');
    expect(edits.length).toBe(1);
  });

  it('a solid-ground rule refuses water even when elevation passes', () => {
    const tool = withResources();
    s.map.setTerrain(4, 4, WATER);
    s.map.setElevation(4, 4, 5);
    tool.pointerDown({ col: 4, row: 4 }, pev());
    tool.pointerUp();
    expect(resource(4, 4)).toBeUndefined();
  });

  it('unchecking "respect rules" bypasses placement checks', () => {
    const tool = withResources();
    const rules = document.getElementById('resource-rules') as HTMLInputElement;
    rules.checked = false;
    rules.dispatchEvent(new Event('change'));
    tool.pointerDown({ col: 2, row: 2 }, pev()); // elevation 0, would be blocked
    tool.pointerUp();
    expect(resource(2, 2)).toBe('iron');
  });

  it('erase mode removes a placed resource', () => {
    const tool = withResources();
    s.map.setElevation(3, 3, 4);
    tool.pointerDown({ col: 3, row: 3 }, pev());
    tool.pointerUp();
    clickOption('#resource-mode-group .scatter-type-btn[data-resource-mode="erase"]');
    tool.pointerDown({ col: 3, row: 3 }, pev());
    tool.pointerUp();
    expect(resource(3, 3)).toBeUndefined();
  });
});

// ---- Fog ----

describe('FogTool', () => {
  it('does nothing while fog is disabled', () => {
    const tool = new FogTool(ctx);
    tool.pointerDown({ col: 5, row: 5 }, pev());
    tool.pointerUp();
    expect(s.fogPaints.length).toBe(0);
  });

  it('reveals a radius-1 footprint cell by cell', () => {
    s.fogEnabled = true;
    const tool = new FogTool(ctx);
    tool.pointerDown({ col: 5, row: 5 }, pev());
    tool.pointerUp();
    expect(s.fogPaints.length).toBe(7);
    expect(s.fogPaints.every(p => p.reveal)).toBe(true);
    expect(edits.length).toBe(0); // exploration stays out of the undo stack
    expect(settingsChanges()).toBeGreaterThan(0); // …but still counts as unsaved
  });

  it('snapshot/restore round-trips the panel and exploration', () => {
    s.fogExplored = 'QUJD';
    const tool = new FogTool(ctx);
    const enable = document.getElementById('fog-enable') as HTMLInputElement;
    enable.checked = true;
    enable.dispatchEvent(new Event('change'));
    const dim = document.getElementById('fog-dim-explored') as HTMLInputElement;
    dim.checked = false;
    dim.dispatchEvent(new Event('change'));
    const snap = tool.snapshot();
    expect(snap).toEqual({ enabled: true, hideUnexplored: true, dimExplored: false, explored: 'QUJD' });

    // A fresh page: the restore must push exploration and panel state back.
    loadEditorDom();
    const s2 = makeScene();
    const tool2 = new FogTool(makeCtx(s2).ctx);
    tool2.restore(snap);
    expect(s2.fogExplored).toBe('QUJD');
    expect(tool2.snapshot()).toEqual(snap);
  });

  it('hide mode re-covers cells', () => {
    s.fogEnabled = true;
    const tool = new FogTool(ctx);
    // The mode buttons stay disabled until fog is switched on in the panel.
    const enable = document.getElementById('fog-enable') as HTMLInputElement;
    enable.checked = true;
    enable.dispatchEvent(new Event('change'));
    clickOption('#fog-mode-group .scatter-type-btn[data-fog-mode="hide"]');
    clickOption('#fog-brush-group .brush-btn[data-brush="0"]');
    tool.pointerDown({ col: 5, row: 5 }, pev());
    tool.pointerUp();
    expect(s.fogPaints).toEqual([{ cells: [{ col: 5, row: 5 }], reveal: false }]);
  });
});
