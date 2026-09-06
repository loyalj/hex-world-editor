import { selectionOpFor } from '../selection.ts';
import { styleChip } from './swatchPreviews.ts';
import type { SceneApi } from '../scene.ts';

export interface TerritoryStatsOptions {
  scene: SceneApi;
}

export interface TerritoryStatsApi {
  /**
   * Recount and redraw. Cheap to call often: a hidden panel skips the work
   * and catches up when shown.
   */
  refresh(): void;
}

/** What the panel reads: the map's size and who owns each cell. */
type HoldingsView = Pick<SceneApi, 'map' | 'territory'>;

/** Cells per faction id across the whole map; unowned cells aren't counted. */
export function countHoldings(scene: HoldingsView): Map<string, number> {
  const counts = new Map<string, number>();
  const { map, territory } = scene;
  if (!territory) return counts;
  for (let row = 0; row < map.height; row++) {
    for (let col = 0; col < map.width; col++) {
      const owner = territory.ownerOf(col, row);
      if (owner !== null) counts.set(owner, (counts.get(owner) ?? 0) + 1);
    }
  }
  return counts;
}

/** Every cell a faction holds — what a holdings row selects. */
export function cellsOfFaction(scene: HoldingsView, factionId: string): Array<{ col: number; row: number }> {
  const cells: Array<{ col: number; row: number }> = [];
  const { map, territory } = scene;
  if (!territory) return cells;
  for (let row = 0; row < map.height; row++) {
    for (let col = 0; col < map.width; col++) {
      if (territory.ownerOf(col, row) === factionId) cells.push({ col, row });
    }
  }
  return cells;
}

/**
 * The Holdings panel in the right column: one row per faction in the roster
 * with its cell count, share of the map, and a proportional bar in the
 * faction's colour, largest holding first. Clicking a row selects every
 * cell the faction holds — the bridge from "how much does Red hold" to "do
 * something to all of it" — with the selection tools' modifier convention
 * (Shift adds, Alt removes, both keep the overlap). Panel visibility belongs
 * to View ▸ Panels, like the Terrains panel it mirrors.
 */
export function initTerritoryStatsPanel(opts: TerritoryStatsOptions): TerritoryStatsApi {
  const { scene } = opts;
  const panel = document.getElementById('holdings-panel') as HTMLElement;
  const list  = document.getElementById('holdings-list')  as HTMLElement;
  const badge = document.getElementById('holdings-count') as HTMLElement;

  const fmt = new Intl.NumberFormat();
  const pctText = (pct: number): string => (pct < 1 && pct > 0 ? '<1' : String(Math.round(pct)));

  function refresh(): void {
    if (panel.classList.contains('hidden')) return;
    const { map } = scene;
    const total  = map.width * map.height;
    const counts = countHoldings(scene);
    const rows = scene.factions
      .map(faction => ({ faction, count: counts.get(faction.id) ?? 0 }))
      .sort((a, b) => b.count - a.count);

    list.innerHTML = '';
    let claimed = 0;
    for (const { faction, count } of rows) {
      claimed += count;
      const pct = total > 0 ? (count / total) * 100 : 0;
      const row = document.createElement('button');
      row.className = 'stat-row';
      row.dataset['faction'] = faction.id;
      row.classList.toggle('stat-row--empty', count === 0);
      row.title = count === 0
        ? `${faction.name} holds no cells`
        : `Select every cell ${faction.name} holds — Shift adds to the selection, Alt removes`;
      row.disabled = count === 0;

      const chip = document.createElement('span');
      chip.className = 'swatch-chip';
      styleChip(chip, faction.color, null);
      row.appendChild(chip);

      const name = document.createElement('span');
      name.className = 'stat-name';
      name.textContent = faction.name;
      row.appendChild(name);

      const value = document.createElement('span');
      value.className = 'stat-count';
      value.textContent = `${fmt.format(count)} · ${pctText(pct)}%`;
      row.appendChild(value);

      const bar = document.createElement('span');
      bar.className = 'stat-bar';
      const fill = document.createElement('span');
      fill.className = 'stat-bar-fill';
      fill.style.width = `${pct}%`;
      fill.style.background = `#${faction.color.toString(16).padStart(6, '0')}`;
      bar.appendChild(fill);
      row.appendChild(bar);

      row.addEventListener('click', e => {
        scene.selection.apply(cellsOfFaction(scene, faction.id), selectionOpFor(e));
      });
      list.appendChild(row);
    }
    const claimedPct = total > 0 ? (claimed / total) * 100 : 0;
    badge.textContent = `${pctText(claimedPct)}% claimed`;
  }

  refresh();
  return { refresh };
}
