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

describe('TerritoryTool fill, grow, holdings, and sampling', () => {
  const fill = () => clickOption('#territory-scope-group .scatter-type-btn[data-territory-scope="fill"]');
  const release = () => clickOption('#territory-mode-group .scatter-type-btn[data-territory-mode="release"]');
  const setBorder = (key: string, on: boolean) => {
    const el = document.getElementById(`territory-stop-${key}`) as HTMLInputElement;
    el.checked = on;
    el.dispatchEvent(new Event('change', { bubbles: true }));
  };
  const owned = (id: string) => {
    let n = 0;
    for (let r = 0; r < 12; r++) for (let c = 0; c < 12; c++) if (owner(c, r) === id) n++;
    return n;
  };
  /** A river straight down column 5, splitting the map in two. */
  const riverDownCol5 = () => { for (let r = 0; r < 12; r++) s.map.setRiverOutgoing(5, r, 0); };

  it('fill claims the connected region out to a river, as one edit, with a hover preview', () => {
    const tool = withTerritory();
    riverDownCol5();
    fill();
    expect(tool.wantsFillCursor()).toBe(true);
    expect(tool.brushRadius()).toBe(0);
    tool.pointerMove({ col: 2, row: 2 }, pev());
    expect(s.selectionPreviews.at(-1)).toHaveLength(60);
    expect(tool.statusText()).toContain('would change 60');
    tool.pointerDown({ col: 2, row: 2 }, pev());
    tool.pointerUp();
    expect(owned('red')).toBe(60);
    expect(owner(5, 3)).toBeUndefined();
    expect(owner(7, 3)).toBeUndefined();
    expect(edits.length).toBe(1);
  });

  it('the faction border keeps a fill off another faction, and unticking it lets the fill through', () => {
    const tool = withTerritory();
    s.map.setCellData(3, 3, 'owner', 'blue');
    fill();
    tool.pointerDown({ col: 2, row: 2 }, pev());
    tool.pointerUp();
    expect(owner(3, 3)).toBe('blue');
    expect(owned('red')).toBe(143);
    setBorder('factions', false);
    tool.pointerDown({ col: 2, row: 2 }, pev());
    tool.pointerUp();
    expect(owner(3, 3)).toBe('red');
  });

  it('coast and road borders wall a fill too', () => {
    const tool = withTerritory();
    for (let r = 0; r < 12; r++) s.map.setTerrain(5, r, WATER);
    for (let r = 0; r < 12; r++) s.map.setRoad(8, r, 0, true);
    fill();
    tool.pointerDown({ col: 2, row: 2 }, pev());
    tool.pointerUp();
    expect(owned('red')).toBe(60);
    setBorder('coast', false);
    tool.pointerDown({ col: 2, row: 2 }, pev());
    tool.pointerUp();
    expect(owner(5, 2)).toBe('red');
    expect(owner(6, 2)).toBe('red');
    expect(owner(8, 2)).toBeUndefined(); // the road still walls it
  });

  it('release fill lets go of the clicked faction\'s connected region only', () => {
    const tool = withTerritory();
    for (let c = 0; c < 4; c++) s.map.setCellData(c, 2, 'owner', 'red');
    s.map.setCellData(9, 9, 'owner', 'red');
    s.map.setCellData(4, 2, 'owner', 'blue');
    fill();
    release();
    tool.pointerDown({ col: 1, row: 2 }, pev());
    tool.pointerUp();
    expect(owned('red')).toBe(1);
    expect(owner(9, 9)).toBe('red');
    expect(owner(4, 2)).toBe('blue');
    // A release fill on unowned ground is a no-op.
    tool.pointerDown({ col: 6, row: 6 }, pev());
    tool.pointerUp();
    expect(edits.length).toBe(1);
  });

  it('grow claims one ring, stopping at rivers, and takes neighbours only with the border off', () => {
    withTerritory();
    s.map.setCellData(5, 5, 'owner', 'red');
    s.map.setCellData(6, 5, 'owner', 'blue');
    s.map.setRiverOutgoing(4, 5, 0);
    document.getElementById('territory-grow')!.click();
    expect(owned('red')).toBe(5); // the ring of 6, less the river cell and Blue's
    expect(owner(4, 5)).toBeUndefined();
    expect(owner(6, 5)).toBe('blue');
    expect(edits.length).toBe(1);
    setBorder('factions', false);
    document.getElementById('territory-grow')!.click();
    expect(owner(6, 5)).toBe('red');
  });

  it('Alt+click samples the faction under the cursor; right-click releases', () => {
    const tool = withTerritory();
    s.map.setCellData(3, 3, 'owner', 'blue');
    tool.pointerDown({ col: 3, row: 3 }, pev({ altKey: true }));
    tool.pointerUp();
    expect(edits.length).toBe(0);
    expect(document.querySelector('#faction-group .swatch-row.active')!.getAttribute('data-id')).toBe('blue');
    tool.pointerDown({ col: 4, row: 4 }, pev());
    tool.pointerUp();
    expect(owner(4, 4)).toBe('blue');
    tool.rightClick({ col: 4, row: 4 }, pev());
    expect(owner(4, 4)).toBeUndefined();
    expect(tool.statusText()).toContain('Blue · claim'); // the mode came back
    // Alt on unowned ground changes nothing.
    tool.pointerDown({ col: 8, row: 8 }, pev({ altKey: true }));
    expect(document.querySelector('#faction-group .swatch-row.active')!.getAttribute('data-id')).toBe('blue');
  });

  it('transfer gives the selection to the faction, as one edit', () => {
    withTerritory();
    s.map.setCellData(2, 2, 'owner', 'blue');
    s.selection.apply([{ col: 2, row: 2 }, { col: 3, row: 2 }, { col: 4, row: 2 }], 'replace');
    document.getElementById('territory-transfer-selection')!.click();
    expect(owner(2, 2)).toBe('red');
    expect(owner(4, 2)).toBe('red');
    expect(owned('red')).toBe(3);
    expect(edits.length).toBe(1);
    s.selection.clear();
    document.getElementById('territory-transfer-selection')!.click();
    expect(edits.length).toBe(1);
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

describe('ResourceTool refusals, sampling, highlight, and scatter', () => {
  const descs = [
    { id: 'iron', name: 'Iron', color: 0x888888, placement: { minElevation: 2 } },
    { id: 'fish', name: 'Fish', color: 0x3366ff, placement: { requiresLiquid: true } },
    { id: 'salt', name: 'Salt', color: 0xffffff, placement: { minSpacing: 3 } },
    { id: 'gems', name: 'Gems', color: 0xff00ff },
  ];
  function withTypes(): ResourceTool {
    s.resourceDescriptors = descs;
    s.resources = {
      resourceKey: 'resource',
      resourceAt: (c: number, r: number) => (s.map.getCellData(c, r, 'resource') as string | undefined) ?? null,
      getDescriptor: (id: string) => descs.find(d => d.id === id),
    };
    const tool = new ResourceTool(ctx);
    tool.panel.classList.remove('hidden');
    return tool;
  }
  const pick = (id: string) => (document.querySelector(`#resource-group .swatch-row[data-id="${id}"]`) as HTMLButtonElement).click();
  const placed = (id: string) => {
    let n = 0;
    for (let r = 0; r < 12; r++) for (let c = 0; c < 12; c++) if (resource(c, r) === id) n++;
    return n;
  };

  it('the status strip names the rule refusing the hovered cell', () => {
    const tool = withTypes();
    s.hoveredCell = { col: 2, row: 2 };
    expect(tool.statusText()).toContain('not here: needs elevation ≥ 2 (here 0)');
    s.map.setElevation(2, 2, 4);
    expect(tool.statusText()).not.toContain('not here');
    pick('fish');
    expect(tool.statusText()).toContain('not here: needs open water');
    s.map.setTerrain(2, 2, WATER);
    expect(tool.statusText()).not.toContain('not here');
    pick('iron');
    expect(tool.statusText()).toContain('not here: needs solid ground');
    // With rules off nothing is refused, so nothing is reported.
    const rules = document.getElementById('resource-rules') as HTMLInputElement;
    rules.checked = false;
    rules.dispatchEvent(new Event('change'));
    expect(tool.statusText()).not.toContain('not here');
  });

  it('Alt+click samples the resource under the cursor into the palette', () => {
    const tool = withTypes();
    s.map.setCellData(3, 3, 'resource', 'gems');
    tool.pointerDown({ col: 3, row: 3 }, pev({ altKey: true }));
    tool.pointerUp();
    expect(edits.length).toBe(0);
    expect(document.querySelector('#resource-group .swatch-row.active')!.getAttribute('data-id')).toBe('gems');
    tool.pointerDown({ col: 4, row: 4 }, pev());
    tool.pointerUp();
    expect(resource(4, 4)).toBe('gems');
    tool.pointerDown({ col: 8, row: 8 }, pev({ altKey: true })); // bare cell: no change
    expect(document.querySelector('#resource-group .swatch-row.active')!.getAttribute('data-id')).toBe('gems');
  });

  it('the highlight tints every cell the chosen rules admit and follows the pick', () => {
    const tool = withTypes();
    for (let c = 0; c < 5; c++) s.map.setElevation(c, 0, 3);
    for (let c = 0; c < 2; c++) s.map.setTerrain(c, 1, WATER);
    const highlight = document.getElementById('resource-highlight') as HTMLInputElement;
    highlight.checked = true;
    highlight.dispatchEvent(new Event('change'));
    expect(s.resourceHighlights.at(-1)).toHaveLength(5); // iron: elevation ≥ 2
    pick('fish');
    expect(s.resourceHighlights.at(-1)).toHaveLength(2); // the water cells
    pick('gems');
    expect(s.resourceHighlights.at(-1)).toHaveLength(144); // no rule: everywhere
    s.map.setTerrain(5, 5, WATER);
    pick('fish');
    tool.refreshHighlight();
    expect(s.resourceHighlights.at(-1)).toHaveLength(3);
    tool.deactivate();
    expect(s.resourceHighlights.at(-1)).toBeNull();
    tool.activate();
    expect(s.resourceHighlights.at(-1)).toHaveLength(3);
    highlight.checked = false;
    highlight.dispatchEvent(new Event('change'));
    expect(s.resourceHighlights.at(-1)).toBeNull();
  });

  it('scatter drops N across the selection on free eligible cells, as one edit', () => {
    const tool = withTypes();
    for (let c = 0; c < 6; c++) s.map.setElevation(c, 2, 4); // six eligible iron cells in row 2
    s.map.setCellData(0, 2, 'resource', 'gems');             // one already taken
    s.selection.apply([0, 1, 2, 3, 4, 5, 6, 7].map(c => ({ col: c, row: 2 })), 'replace');
    (document.getElementById('resource-scatter-count') as HTMLInputElement).value = '3';
    document.getElementById('resource-scatter-count')!.dispatchEvent(new Event('input'));
    document.getElementById('resource-scatter-btn')!.click();
    expect(placed('iron')).toBe(3);
    expect(resource(0, 2)).toBe('gems');
    expect(resource(6, 2)).toBeUndefined(); // elevation 0: refused
    expect(edits.length).toBe(1);
    expect(tool.statusText()).toContain('scattered 3 Iron across the selection');
    // Asking for more than there is says so.
    (document.getElementById('resource-scatter-count') as HTMLInputElement).value = '10';
    document.getElementById('resource-scatter-count')!.dispatchEvent(new Event('input'));
    document.getElementById('resource-scatter-btn')!.click();
    expect(placed('iron')).toBe(5);
    expect(tool.statusText()).toContain('scattered 2 of 10 Iron');
    document.getElementById('resource-scatter-btn')!.click();
    expect(tool.statusText()).toContain('nothing to scatter');
    expect(edits.length).toBe(2);
  });

  it('scatter keeps the minimum spacing between deposits, and rules off ignores it', () => {
    const tool = withTypes();
    pick('salt');
    (document.getElementById('resource-scatter-count') as HTMLInputElement).value = '50';
    document.getElementById('resource-scatter-count')!.dispatchEvent(new Event('input'));
    document.getElementById('resource-scatter-btn')!.click(); // whole map: no selection
    const n = placed('salt');
    expect(n).toBeGreaterThan(3);
    expect(n).toBeLessThan(50);
    // No two deposits closer than 3.
    const cells: Array<{ col: number; row: number }> = [];
    for (let r = 0; r < 12; r++) for (let c = 0; c < 12; c++) if (resource(c, r) === 'salt') cells.push({ col: c, row: r });
    for (const a of cells) for (const b of cells) {
      if (a === b) continue;
      const d = Math.max(Math.abs(a.col - b.col), Math.abs(a.row - b.row));
      expect(d).toBeGreaterThanOrEqual(2); // offset-space lower bound on hex distance 3
    }
    expect(tool.statusText()).toContain('spacing left room for no more in the map');
    const rules = document.getElementById('resource-rules') as HTMLInputElement;
    rules.checked = false;
    rules.dispatchEvent(new Event('change'));
    document.getElementById('resource-scatter-btn')!.click();
    expect(placed('salt')).toBe(n + 50);
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
