import type { TerrainDescriptor } from '@loyalj/hex-world';
import { buildChipRow } from './uiHelpers.ts';
import type { SceneApi } from '../scene.ts';

export interface LocksPanelOptions {
  scene: SceneApi;
  /** Live getter — the palette owns the descriptors and swaps them on load. */
  terrains(): TerrainDescriptor[];
  /** Reveal the Locks panel (flips View ▸ Panels ▸ Locks on). Wired by main. */
  showPanel(): void;
}

export interface LocksPanelApi {
  /** Rebuild the rows and chip — call when the terrain roster or locks change. */
  refresh(): void;
}

/**
 * The Locks panel in the right column: one row per terrain type, click to
 * toggle its lock, plus the status-strip chip that keeps active locks visible
 * even while the panel is hidden. Content only — panel *visibility* belongs
 * to the View ▸ Panels toggles in menus.ts, reached from here via showPanel.
 */
export function initLocksPanel(opts: LocksPanelOptions): LocksPanelApi {
  const { scene } = opts;
  const list  = document.getElementById('locks-list')        as HTMLElement;
  const badge = document.getElementById('locks-count')       as HTMLElement;
  const chip  = document.getElementById('status-locks-chip') as HTMLButtonElement;

  chip.addEventListener('click', () => opts.showPanel());
  (document.getElementById('locks-unlock-all') as HTMLButtonElement)
    .addEventListener('click', () => scene.locks.unlockAll());

  function refresh(): void {
    list.innerHTML = '';
    for (const desc of opts.terrains()) {
      const locked = scene.locks.isLocked(desc.index);
      const row = buildChipRow(String(desc.index), desc.name, desc.color, false,
        () => scene.locks.toggle(desc.index));
      row.title = locked
        ? `${desc.name} is locked — no tool can modify its cells`
        : `Lock ${desc.name} — protect its cells from every tool`;
      row.classList.toggle('swatch-row--locked', locked);
      const glyph = document.createElement('span');
      glyph.className = 'lock-glyph';
      glyph.textContent = locked ? '🔒' : '🔓';
      row.appendChild(glyph);
      list.appendChild(row);
    }
    badge.textContent = String(scene.locks.size);
    // The chip is the can't-miss indicator: visible exactly while locks exist,
    // so a hidden panel never means silently blocked edits.
    chip.classList.toggle('hidden', scene.locks.size === 0);
    chip.textContent = `🔒 ${scene.locks.size}`;
  }

  refresh();
  return { refresh };
}
