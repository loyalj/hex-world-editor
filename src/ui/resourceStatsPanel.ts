import { selectionOpFor } from '../selection.ts';
import { styleChip } from './swatchPreviews.ts';
import type { SceneApi } from '../scene.ts';

export interface ResourceStatsOptions {
  scene: SceneApi;
}

export interface ResourceStatsApi {
  /**
   * Recount and redraw. Cheap to call often: a hidden panel skips the work
   * and catches up when shown.
   */
  refresh(): void;
}

/** What the panel reads: the map's size and what each cell holds. */
type ResourcesView = Pick<SceneApi, 'map' | 'resources'>;

/** Cells per resource id across the whole map; bare cells aren't counted. */
export function countResources(scene: ResourcesView): Map<string, number> {
  const counts = new Map<string, number>();
  const { map, resources } = scene;
  if (!resources) return counts;
  for (let row = 0; row < map.height; row++) {
    for (let col = 0; col < map.width; col++) {
      const id = resources.resourceAt(col, row);
      if (id !== null) counts.set(id, (counts.get(id) ?? 0) + 1);
    }
  }
  return counts;
}

/** Every cell holding a resource type — what a stats row selects. */
export function cellsOfResource(scene: ResourcesView, id: string): Array<{ col: number; row: number }> {
  const cells: Array<{ col: number; row: number }> = [];
  const { map, resources } = scene;
  if (!resources) return cells;
  for (let row = 0; row < map.height; row++) {
    for (let col = 0; col < map.width; col++) {
      if (resources.resourceAt(col, row) === id) cells.push({ col, row });
    }
  }
  return cells;
}

/**
 * The Resources panel in the right column: one row per resource type in the
 * roster with how many cells hold it, most placed first, plus a bar scaled
 * to the largest count so the mix reads at a glance. Clicking a row selects
 * every cell holding that type, with the selection tools' modifier
 * convention (Shift adds, Alt removes, both keep the overlap). Panel
 * visibility belongs to View ▸ Panels, like the Terrains and Holdings panels.
 */
export function initResourceStatsPanel(opts: ResourceStatsOptions): ResourceStatsApi {
  const { scene } = opts;
  const panel = document.getElementById('resource-stats-panel') as HTMLElement;
  const list  = document.getElementById('resource-stats-list')  as HTMLElement;
  const badge = document.getElementById('resource-stats-count') as HTMLElement;

  const fmt = new Intl.NumberFormat();

  function refresh(): void {
    if (panel.classList.contains('hidden')) return;
    const counts = countResources(scene);
    const rows = scene.resourceDescriptors
      .map(desc => ({ desc, count: counts.get(desc.id) ?? 0 }))
      .sort((a, b) => b.count - a.count);
    const most = rows[0]?.count ?? 0;

    list.innerHTML = '';
    let total = 0;
    for (const { desc, count } of rows) {
      total += count;
      const row = document.createElement('button');
      row.className = 'stat-row';
      row.dataset['resource'] = desc.id;
      row.classList.toggle('stat-row--empty', count === 0);
      row.title = count === 0
        ? `No ${desc.name} on the map`
        : `Select every cell holding ${desc.name} — Shift adds to the selection, Alt removes`;
      row.disabled = count === 0;

      const chip = document.createElement('span');
      chip.className = 'swatch-chip';
      styleChip(chip, desc.color, null);
      row.appendChild(chip);

      const name = document.createElement('span');
      name.className = 'stat-name';
      name.textContent = desc.name;
      row.appendChild(name);

      const value = document.createElement('span');
      value.className = 'stat-count';
      value.textContent = fmt.format(count);
      row.appendChild(value);

      const bar = document.createElement('span');
      bar.className = 'stat-bar';
      const fill = document.createElement('span');
      fill.className = 'stat-bar-fill';
      fill.style.width = most > 0 ? `${(count / most) * 100}%` : '0%';
      fill.style.background = `#${desc.color.toString(16).padStart(6, '0')}`;
      bar.appendChild(fill);
      row.appendChild(bar);

      row.addEventListener('click', e => {
        scene.selection.apply(cellsOfResource(scene, desc.id), selectionOpFor(e));
      });
      list.appendChild(row);
    }
    badge.textContent = `${fmt.format(total)} placed`;
  }

  refresh();
  return { refresh };
}
