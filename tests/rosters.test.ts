// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MapEdit, FactionDescriptor, ResourceDescriptor, TerrainDescriptor } from '@loyalj/hex-world';
import { TerritoryTool } from '../src/tools/territoryTool.ts';
import { ResourceTool } from '../src/tools/resourceTool.ts';
import { initRosters, parseYields, formatYields } from '../src/ui/rosters.ts';
import type { RostersApi } from '../src/ui/rosters.ts';
import { loadEditorDom, makeCtx, makeScene } from './helpers.ts';
import type { FakeScene } from './helpers.ts';
import type { ToolContext } from '../src/tools/tool.ts';

const TERRAINS: TerrainDescriptor[] = [
  { index: 0, id: 'grass', name: 'Grass', color: 0x44aa55, texture: { type: 'procedural' } },
  { index: 3, id: 'rock',  name: 'Rock',  color: 0x8a7a6a, texture: { type: 'procedural' } },
];

let s: FakeScene;
let ctx: ToolContext;
let edits: MapEdit[];
let settingsChanges: () => number;
let rosters: RostersApi;

/** Fake-scene rosters as the typed arrays the module hands back. */
const factions      = () => s.factions as FactionDescriptor[];
const resourceTypes = () => s.resourceDescriptors as ResourceDescriptor[];

beforeEach(() => {
  loadEditorDom();
  // happy-dom's <dialog> lacks showModal in some versions — the tests only
  // need the form logic, not modality.
  for (const d of document.querySelectorAll('dialog')) {
    const dlg = d as HTMLDialogElement;
    if (!dlg.showModal) dlg.showModal = () => { dlg.open = true; };
    if (!dlg.close)     dlg.close     = () => { dlg.open = false; };
  }
  vi.stubGlobal('confirm', () => true);
  vi.stubGlobal('alert', () => {});

  s = makeScene();
  s.factions = [
    { id: 'red',  name: 'Red',  color: 0xff0000 },
    { id: 'blue', name: 'Blue', color: 0x0000ff },
  ] satisfies FactionDescriptor[];
  s.resourceDescriptors = [
    { id: 'iron', name: 'Iron', color: 0x888888, placement: { minElevation: 2 } },
    { id: 'gems', name: 'Gems', color: 0xff00ff, yields: { gold: 3 } },
  ] satisfies ResourceDescriptor[];
  s.territory = {
    ownerKey: 'owner',
    ownerOf: (c: number, r: number) => (s.map.getCellData(c, r, 'owner') as string | undefined) ?? null,
  };
  s.resources = {
    resourceKey: 'resource',
    resourceAt: (c: number, r: number) => (s.map.getCellData(c, r, 'resource') as string | undefined) ?? null,
    getDescriptor: (id: string) => resourceTypes().find(d => d.id === id),
  };

  const made = makeCtx(s);
  ctx = made.ctx;
  edits = made.edits;
  settingsChanges = made.settingsChanges;
  rosters = initRosters({
    ctx,
    territoryTool: new TerritoryTool(ctx),
    resourceTool:  new ResourceTool(ctx),
    terrains: () => TERRAINS,
  });
});

const setValue = (id: string, value: string): void => {
  const el = document.getElementById(id) as HTMLInputElement | HTMLSelectElement;
  el.value = value;
  el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
};
const setChecked = (id: string, checked: boolean): void => {
  const el = document.getElementById(id) as HTMLInputElement;
  el.checked = checked;
  el.dispatchEvent(new Event('change', { bubbles: true }));
};
const click = (id: string): void => (document.getElementById(id) as HTMLButtonElement).click();

// ---- Yields parsing ----

describe('yields round-trip', () => {
  it('parses, rejects garbage, and formats back', () => {
    expect(parseYields('food: 2, gold: 1')).toEqual({ food: 2, gold: 1 });
    expect(parseYields('  ')).toBeUndefined();
    expect(parseYields('food is nice')).toBeNull();
    expect(formatYields({ food: 2, gold: 1 })).toBe('food: 2, gold: 1');
    expect(formatYields(undefined)).toBe('');
  });
});

// ---- Factions ----

describe('faction dialog', () => {
  it('renames and recolors a faction, refreshing the tool palette', () => {
    rosters.openFactionDialog();
    setValue('faction-name', 'Crimson Pact');
    setValue('faction-color', '#aa1122');
    click('faction-apply-btn');

    expect(factions()[0]).toEqual({ id: 'red', name: 'Crimson Pact', color: 0xaa1122 });
    expect(rosters.factions).toBe(factions());
    expect(settingsChanges()).toBeGreaterThan(0);

    const rows = document.querySelectorAll('#faction-group .swatch-name');
    expect(rows[0].textContent).toBe('Crimson Pact');
  });

  it('sets and clears a custom border color', () => {
    rosters.openFactionDialog();
    setChecked('faction-border-custom', true);
    setValue('faction-border', '#ffffff');
    click('faction-apply-btn');
    expect(factions()[0].borderColor).toBe(0xffffff);

    setChecked('faction-border-custom', false);
    click('faction-apply-btn');
    expect(factions()[0].borderColor).toBeUndefined();
  });

  it('adds a fifth faction with a slug id', () => {
    rosters.openFactionDialog();
    setValue('faction-select', '__new');
    setValue('faction-name', 'Iron Concord');
    setValue('faction-color', '#333344');
    click('faction-apply-btn');

    expect(factions()).toHaveLength(3);
    expect(factions()[2]).toEqual({ id: 'iron-concord', name: 'Iron Concord', color: 0x333344 });
    // The select lands on the new faction, ready for further edits.
    expect((document.getElementById('faction-select') as HTMLSelectElement).value).toBe('iron-concord');
  });

  it('deletes a faction and releases its cells as one undoable edit', () => {
    s.map.setCellData(2, 2, 'owner', 'red');
    s.map.setCellData(5, 5, 'owner', 'blue');

    rosters.openFactionDialog();
    setValue('faction-select', 'red');
    click('faction-delete-btn');

    expect(factions().map(f => f.id)).toEqual(['blue']);
    expect(s.map.getCellData(2, 2, 'owner')).toBeUndefined();
    expect(s.map.getCellData(5, 5, 'owner')).toBe('blue');
    expect(edits).toHaveLength(1);

    edits[0].undo();
    expect(s.map.getCellData(2, 2, 'owner')).toBe('red');
  });

  it('refuses to delete the last faction', () => {
    rosters.openFactionDialog();
    setValue('faction-select', 'red');
    click('faction-delete-btn');
    click('faction-delete-btn'); // now only blue is left
    expect(factions()).toHaveLength(1);
  });
});

// ---- Resource types ----

describe('resource dialog', () => {
  it('edits placement rules through the form', () => {
    rosters.openResourceDialog(); // iron selected, minElevation 2 in the form
    expect((document.getElementById('resource-elev-min') as HTMLInputElement).value).toBe('2');

    setValue('resource-elev-min', '4');
    setValue('resource-elev-max', '9');
    setChecked('resource-req-coast', true);
    // Toggle both terrain chips on.
    document.querySelectorAll<HTMLButtonElement>('#resource-terrains .terrain-filter-btn')
      .forEach(b => b.click());
    setValue('resource-frequency', '0.5');
    setValue('resource-spacing', '3');
    click('resource-apply-btn');

    expect(resourceTypes()[0].placement).toEqual({
      allowedTerrains: [0, 3],
      minElevation: 4,
      maxElevation: 9,
      requiresCoast: true,
      frequency: 0.5,
      minSpacing: 3,
    });
    expect(rosters.resourceTypes).toBe(resourceTypes());
  });

  it('clearing every rule field drops the placement rule entirely', () => {
    rosters.openResourceDialog();
    setValue('resource-elev-min', '');
    click('resource-apply-btn');
    expect(resourceTypes()[0].placement).toBeUndefined();
  });

  it('edits yields and keeps fields the form does not touch', () => {
    rosters.openResourceDialog();
    setValue('resource-select', 'gems');
    expect((document.getElementById('resource-yields') as HTMLInputElement).value).toBe('gold: 3');
    setValue('resource-yields', 'gold: 5, prestige: 1');
    click('resource-apply-btn');
    expect(resourceTypes()[1].yields).toEqual({ gold: 5, prestige: 1 });
  });

  it('adds a new resource type with an on-water rule', () => {
    rosters.openResourceDialog();
    setValue('resource-select', '__new');
    setValue('resource-name', 'Whales');
    setChecked('resource-req-liquid', true);
    click('resource-apply-btn');

    expect(resourceTypes()).toHaveLength(3);
    expect(resourceTypes()[2].id).toBe('whales');
    expect(resourceTypes()[2].placement).toEqual({ requiresLiquid: true });
    // The tool palette picked up the new type.
    const names = [...document.querySelectorAll('#resource-group .swatch-name')].map(el => el.textContent);
    expect(names).toContain('Whales');
  });

  it('deletes a type and removes its deposits, undoably', () => {
    s.map.setCellData(3, 3, 'resource', 'iron');
    rosters.openResourceDialog();
    setValue('resource-select', 'iron');
    click('resource-delete-btn');

    expect(resourceTypes().map(d => d.id)).toEqual(['gems']);
    expect(s.map.getCellData(3, 3, 'resource')).toBeUndefined();
    expect(edits).toHaveLength(1);
  });
});

// ---- Load adoption ----

describe('applyLoaded', () => {
  it('adopts rosters from a save and falls back to defaults when absent', () => {
    const loadedFactions: FactionDescriptor[] = [{ id: 'x', name: 'X', color: 0x123456 }];
    rosters.applyLoaded(loadedFactions, []);
    expect(factions()).toEqual(loadedFactions);
    // Empty resource set → editor defaults, not an empty palette.
    expect(resourceTypes().length).toBeGreaterThan(0);
    expect(resourceTypes().map(d => d.id)).toContain('ore');
  });
});
