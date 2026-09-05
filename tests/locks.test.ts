// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MapEdit } from '@loyalj/hex-world';
import { LockModel } from '../src/locks.ts';
import { TerrainTool } from '../src/tools/terrainTool.ts';
import { UnitTool } from '../src/tools/unitTool.ts';
import { FogTool } from '../src/tools/fogTool.ts';
import { clearMetadataKey } from '../src/tools/tool.ts';
import type { ToolContext } from '../src/tools/tool.ts';
import { initLocksPanel } from '../src/ui/locksPanel.ts';
import { EDITOR_DEFAULT_TERRAINS } from '../src/ui/palette.ts';
import { UNIT_KEY, unitAt } from '../src/unitTypes.ts';
import type { SceneApi } from '../src/scene.ts';
import { clickOption, countCells, loadEditorDom, makeCtx, makeScene, pev, setInput } from './helpers.ts';
import type { FakeScene } from './helpers.ts';

describe('LockModel', () => {
  it('tracks lock state and fires onChange only on real changes', () => {
    const locks = new LockModel();
    let changes = 0;
    locks.onChange = () => changes++;

    locks.setLocked(3, true);
    expect(locks.isLocked(3)).toBe(true);
    expect(locks.size).toBe(1);
    locks.setLocked(3, true); // already locked — no event
    expect(changes).toBe(1);

    locks.toggle(3);
    expect(locks.isLocked(3)).toBe(false);
    expect(changes).toBe(2);

    locks.unlockAll(); // already empty — no event
    expect(changes).toBe(2);
  });

  it('round-trips through indices/setIndices in stable order', () => {
    const locks = new LockModel();
    locks.setIndices([7, 2, 5]);
    expect(locks.indices()).toEqual([2, 5, 7]);
    expect(locks.isLocked(5)).toBe(true);
    locks.setIndices([]);
    expect(locks.size).toBe(0);
  });
});

describe('lock enforcement across tools', () => {
  let s: FakeScene;
  let ctx: ToolContext;
  let edits: MapEdit[];

  beforeEach(() => {
    loadEditorDom();
    s = makeScene();
    const made = makeCtx(s);
    ctx = made.ctx;
    edits = made.edits;
  });

  it('the terrain brush stamps around locked cells, not over them', () => {
    const tool = new TerrainTool(ctx);
    s.map.setTerrain(5, 5, 2); // the footprint's centre is protected
    s.locks.setLocked(2, true);
    setInput('terrain-brush-size', '1'); // 7 cells
    tool.paintTerrain = 1;
    tool.pointerDown({ col: 5, row: 5 }, pev());
    tool.pointerUp();

    expect(s.map.getTerrain(5, 5)).toBe(2);
    expect(countCells(s.map, (c, r) => s.map.getTerrain(c, r) === 1)).toBe(6);
  });

  it('flood fill on a locked region is a full no-op', () => {
    const tool = new TerrainTool(ctx);
    s.map.setTerrain(2, 2, 2);
    s.map.setTerrain(3, 2, 2);
    s.locks.setLocked(2, true);
    clickOption('#terrain-mode-group .scatter-type-btn[data-terrain-mode="fill"]');
    tool.paintTerrain = 1;
    tool.pointerDown({ col: 2, row: 2 }, pev());

    expect(s.map.getTerrain(2, 2)).toBe(2);
    expect(edits.length).toBe(0);
  });

  it('units cannot be placed on locked terrain', () => {
    const tool = new UnitTool(ctx); // infantry on land by default
    s.locks.setLocked(0, true);
    tool.pointerDown({ col: 4, row: 4 }, pev());
    tool.pointerUp();
    expect(unitAt(s.map, 4, 4)).toBeNull();
    expect(edits.length).toBe(0);
  });

  it('clearMetadataKey keeps data on protected cells', () => {
    s.map.setCellData(1, 1, UNIT_KEY, { type: 'infantry', faction: 'red' });
    s.map.setCellData(2, 2, UNIT_KEY, { type: 'archer', faction: 'red' });
    s.map.setTerrain(2, 2, 3);
    s.locks.setLocked(3, true);

    clearMetadataKey(ctx, UNIT_KEY, (c, r) => unitAt(s.map, c, r) !== null);
    expect(unitAt(s.map, 1, 1)).toBeNull();
    expect(unitAt(s.map, 2, 2)).not.toBeNull();
  });

  it('fog exploration ignores locks — it is player state, not map content', () => {
    const tool = new FogTool(ctx);
    s.fogEnabled = true;
    s.locks.setLocked(0, true); // every cell's terrain is locked
    tool.pointerDown({ col: 3, row: 3 }, pev());
    tool.pointerUp();
    expect(s.fogPaints.length).toBeGreaterThan(0);
  });
});

describe('locks panel', () => {
  let s: FakeScene;
  let showPanel: ReturnType<typeof vi.fn<() => void>>;

  const chip = () => document.getElementById('status-locks-chip')!;
  const rows = () => [...document.querySelectorAll<HTMLElement>('#locks-list .swatch-row')];

  beforeEach(() => {
    loadEditorDom();
    s = makeScene();
    showPanel = vi.fn<() => void>();
    const panel = initLocksPanel({
      scene: s as unknown as SceneApi,
      terrains: () => EDITOR_DEFAULT_TERRAINS,
      showPanel,
    });
    s.locks.onChange = () => panel.refresh();
  });

  it('lists every terrain and toggles its lock on click', () => {
    expect(rows().length).toBe(EDITOR_DEFAULT_TERRAINS.length);

    rows()[2].click();
    expect(s.locks.isLocked(EDITOR_DEFAULT_TERRAINS[2].index)).toBe(true);
    expect(rows()[2].classList.contains('swatch-row--locked')).toBe(true);

    rows()[2].click();
    expect(s.locks.size).toBe(0);
    expect(rows()[2].classList.contains('swatch-row--locked')).toBe(false);
  });

  it('shows the status chip exactly while locks are active', () => {
    expect(chip().classList.contains('hidden')).toBe(true);

    rows()[0].click();
    rows()[1].click();
    expect(chip().classList.contains('hidden')).toBe(false);
    expect(chip().textContent).toContain('2');
    expect(document.getElementById('locks-count')!.textContent).toBe('2');

    document.getElementById('locks-unlock-all')!.click();
    expect(s.locks.size).toBe(0);
    expect(chip().classList.contains('hidden')).toBe(true);
  });

  it('the chip opens the panel', () => {
    rows()[0].click();
    chip().click();
    expect(showPanel).toHaveBeenCalled();
  });
});
