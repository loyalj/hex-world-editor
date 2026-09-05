import type { HexMap, TerrainDescriptor } from '@loyalj/hex-world';
import { selectionOpFor } from '../selection.ts';
import { styleChip } from './swatchPreviews.ts';
import type { SceneApi } from '../scene.ts';

export interface TerrainStatsOptions {
  scene: SceneApi;
  /** Live getter — the palette owns the descriptors and swaps them on load. */
  terrains(): TerrainDescriptor[];
  /** The palette's terrain thumbnail for a chip, when rendered. */
  previewFor?(index: number): string | null;
}

export interface TerrainStatsApi {
  /**
   * Recount and redraw. Cheap to call often: a hidden panel skips the work
   * and catches up when shown.
   */
  refresh(): void;
}

/** Cells per terrain index across the whole map. */
export function countTerrains(map: HexMap): Map<number, number> {
  const counts = new Map<number, number>();
  for (let row = 0; row < map.height; row++) {
    for (let col = 0; col < map.width; col++) {
      const t = map.getTerrain(col, row);
      counts.set(t, (counts.get(t) ?? 0) + 1);
    }
  }
  return counts;
}

/** Every cell holding a terrain — what a stats row selects. */
export function cellsOfTerrain(map: HexMap, terrain: number): Array<{ col: number; row: number }> {
  const cells: Array<{ col: number; row: number }> = [];
  for (let row = 0; row < map.height; row++) {
    for (let col = 0; col < map.width; col++) {
      if (map.getTerrain(col, row) === terrain) cells.push({ col, row });
    }
  }
  return cells;
}

/**
 * The Terrains panel in the right column: one row per terrain in the roster
 * with its cell count, share of the map, and a proportional bar, most
 * common first. Clicking a row selects every cell of that terrain — the
 * bridge from "how much marsh is there" to "do something to all of it" —
 * with the selection tools' modifier convention (Shift adds, Alt removes,
 * both keep the overlap). Panel visibility belongs to View ▸ Panels.
 */
export function initTerrainStatsPanel(opts: TerrainStatsOptions): TerrainStatsApi {
  const { scene } = opts;
  const panel = document.getElementById('terrains-panel') as HTMLElement;
  const list  = document.getElementById('terrains-list')  as HTMLElement;
  const badge = document.getElementById('terrains-count') as HTMLElement;

  const fmt = new Intl.NumberFormat();

  function refresh(): void {
    if (panel.classList.contains('hidden')) return;
    const { map } = scene;
    const total  = map.width * map.height;
    const counts = countTerrains(map);
    const rows = opts.terrains()
      .map(desc => ({ desc, count: counts.get(desc.index) ?? 0 }))
      .sort((a, b) => b.count - a.count);

    list.innerHTML = '';
    for (const { desc, count } of rows) {
      const pct = total > 0 ? (count / total) * 100 : 0;
      const row = document.createElement('button');
      row.className = 'stat-row';
      row.dataset['terrain'] = String(desc.index);
      row.classList.toggle('stat-row--empty', count === 0);
      row.title = count === 0
        ? `No ${desc.name} cells on the map`
        : `Select every ${desc.name} cell — Shift adds to the selection, Alt removes`;
      row.disabled = count === 0;

      const chip = document.createElement('span');
      chip.className = 'swatch-chip';
      styleChip(chip, desc.color, opts.previewFor?.(desc.index));
      row.appendChild(chip);

      const name = document.createElement('span');
      name.className = 'stat-name';
      name.textContent = desc.name;
      row.appendChild(name);

      const value = document.createElement('span');
      value.className = 'stat-count';
      value.textContent = `${fmt.format(count)} · ${pct < 1 && pct > 0 ? '<1' : Math.round(pct)}%`;
      row.appendChild(value);

      const bar = document.createElement('span');
      bar.className = 'stat-bar';
      const fill = document.createElement('span');
      fill.className = 'stat-bar-fill';
      fill.style.width = `${pct}%`;
      fill.style.background = `#${desc.color.toString(16).padStart(6, '0')}`;
      bar.appendChild(fill);
      row.appendChild(bar);

      row.addEventListener('click', e => {
        scene.selection.apply(cellsOfTerrain(scene.map, desc.index), selectionOpFor(e));
      });
      list.appendChild(row);
    }
    const used = rows.filter(r => r.count > 0).length;
    badge.textContent = `${used} of ${rows.length}`;
  }

  refresh();
  return { refresh };
}
