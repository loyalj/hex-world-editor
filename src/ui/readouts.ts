import type { TerrainDescriptor } from '@loyalj/hex-world';
import type { SceneApi } from '../scene.ts';
import type { Minimap } from './minimap.ts';
import type { ToolManager } from '../tools/toolManager.ts';
import type { TerrainTool } from '../tools/terrainTool.ts';
import type { EnvironmentTool } from '../tools/environmentTool.ts';
import { DENSITY_LABELS } from '../tools/scatterTool.ts';
import { computeRiverFlow, riverDestination, upstreamOf, cellKey } from '../tools/riverGraph.ts';

export interface ReadoutsOptions {
  scene: SceneApi;
  minimap: Minimap;
  tools: ToolManager;
  terrainTool: TerrainTool;
  environmentTool: EnvironmentTool;
  /** Live getter — the palette owns the descriptors and swaps them on load. */
  terrains(): TerrainDescriptor[];
}

/**
 * The per-frame readout loop: the hover inspector card, the status strip
 * (active-tool line, position, zoom, fps), and the environment panel's
 * follow-the-sim control sync.
 */
export function initReadouts(opts: ReadoutsOptions): void {
  const { scene, minimap, tools } = opts;

  const statusSwatch = document.getElementById('status-swatch')     as HTMLElement;
  const statusTool   = document.getElementById('status-tool-label') as HTMLElement;
  const statusPos    = document.getElementById('status-pos')        as HTMLElement;
  const statusElev   = document.getElementById('status-elev')       as HTMLElement;
  const statusZoom   = document.getElementById('status-zoom')       as HTMLElement;
  const statusFps    = document.getElementById('status-fps')        as HTMLElement;

  const inspSwatch  = document.getElementById('insp-swatch')   as HTMLElement;
  const inspPos     = document.getElementById('insp-pos')      as HTMLElement;
  const inspTerrain = document.getElementById('insp-terrain')  as HTMLElement;
  const inspElev    = document.getElementById('insp-elev')     as HTMLElement;
  const inspRiver   = document.getElementById('insp-river')    as HTMLElement;
  const inspRoad    = document.getElementById('insp-road')     as HTMLElement;
  const inspRoadCost = document.getElementById('insp-roadcost') as HTMLElement;
  const inspScatterTrees = document.getElementById('insp-scatter-trees') as HTMLElement;
  const inspScatterRocks = document.getElementById('insp-scatter-rocks') as HTMLElement;
  const inspScatterBroadleaf = document.getElementById('insp-scatter-broadleaf') as HTMLElement;
  const inspScatterBushes    = document.getElementById('insp-scatter-bushes')    as HTMLElement;
  const inspRiverFlow  = document.getElementById('insp-river-flow')  as HTMLElement;
  const inspRiverTribs = document.getElementById('insp-river-tribs') as HTMLElement;
  const inspRiverDest  = document.getElementById('insp-river-dest')  as HTMLElement;
  const riverRows = document.querySelectorAll<HTMLElement>('.insp-row--river');

  // Accumulated flow is a whole-map walk; the scene revision says when the
  // rivers could have changed, so one walk serves every hover in between.
  let flowCache: { revision: number; flow: Map<number, number> } | null = null;
  function riverFlow(): Map<number, number> {
    if (!flowCache || flowCache.revision !== scene.revision) {
      flowCache = { revision: scene.revision, flow: computeRiverFlow(scene.map) };
    }
    return flowCache.flow;
  }

  function destinationLabel(col: number, row: number): string {
    const dest = riverDestination(scene.map, t => scene.isWater(t), col, row);
    if (!dest) return '—';
    const at = `${dest.col}, ${dest.row}`;
    if (dest.kind === 'water') return `water at ${at} · ${dest.length} cells`;
    if (dest.kind === 'cycle') return `loops at ${at}`;
    return `land at ${at} · dead end`;
  }

  function riverLabel(col: number, row: number): string {
    const { map } = scene;
    if (!map.hasRiver(col, row)) return 'none';
    if (map.hasRiverBeginOrEnd(col, row)) return map.hasIncomingRiver(col, row) ? 'terminus' : 'source';
    return 'through';
  }

  let lastPerfWrite = 0;

  function updateReadouts(now: number): void {
    const cell = scene.hoveredCell;
    if (cell) {
      const { map } = scene;
      const terrain = map.getTerrain(cell.col, cell.row);
      const elev    = map.getElevation(cell.col, cell.row);
      const hasRoad = map.hasRoads(cell.col, cell.row);
      const desc    = opts.terrains().find(d => d.index === terrain);
      const label   = (l: number) => DENSITY_LABELS[map.getFeatureLevel(cell.col, cell.row, l)] ?? '—';

      inspSwatch.style.background   = `#${(desc?.color ?? 0).toString(16).padStart(6, '0')}`;
      inspPos.textContent           = `${cell.col}, ${cell.row}`;
      inspTerrain.textContent       = scene.terrainLookup.get(terrain)?.name ?? String(terrain);
      inspElev.textContent          = String(elev);
      inspRiver.textContent         = riverLabel(cell.col, cell.row);
      const hasRiver = map.hasRiver(cell.col, cell.row);
      riverRows.forEach(r => r.classList.toggle('hidden', !hasRiver));
      if (hasRiver) {
        inspRiverFlow.textContent  = String(riverFlow().get(cellKey(map, cell.col, cell.row)) ?? 1);
        inspRiverTribs.textContent = String(upstreamOf(map, cell.col, cell.row).length);
        inspRiverDest.textContent  = destinationLabel(cell.col, cell.row);
      }
      inspRoad.textContent          = hasRoad ? 'yes' : 'no';
      inspScatterTrees.textContent     = label(0);
      inspScatterBroadleaf.textContent = label(2);
      inspScatterBushes.textContent    = label(3);
      inspScatterRocks.textContent     = label(1);
      inspRoadCost.textContent      = `${(desc?.roadCost ?? 1).toFixed(1)}×`;

      statusPos.textContent  = `${cell.col}, ${cell.row}`;
      statusElev.textContent = `elev ${elev}`;
    } else {
      inspSwatch.style.background = '';
      riverRows.forEach(r => r.classList.add('hidden'));
      inspPos.textContent = inspTerrain.textContent = inspElev.textContent =
        inspRiver.textContent = inspRoad.textContent = inspRoadCost.textContent =
        inspScatterTrees.textContent = inspScatterRocks.textContent =
        inspScatterBroadleaf.textContent = inspScatterBushes.textContent = '—';
      statusPos.textContent = statusElev.textContent = '—';
    }

    minimap.update(now);

    // With a selection active every other tool is masked to it — say so in the
    // strip, or a brush that "does nothing" outside the mask reads as a bug.
    const maskNote = scene.selection.size > 0 && tools.active.id !== 'select'
      ? ` · masked to ${scene.selection.size} cells`
      : '';
    statusTool.textContent = tools.active.statusText() + maskNote;
    const showSwatch = tools.active.id === 'paint-terrain';
    statusSwatch.classList.toggle('hidden', !showSwatch);
    if (showSwatch) {
      const paint = opts.terrains().find(d => d.index === opts.terrainTool.paintTerrain);
      statusSwatch.style.background = `#${(paint?.color ?? 0).toString(16).padStart(6, '0')}`;
    }

    // Zoom and fps drift constantly — writing them a few times a second keeps
    // the strip readable instead of a blur of changing digits.
    if (now - lastPerfWrite > 250) {
      lastPerfWrite = now;
      statusZoom.textContent = `${scene.zoom.toFixed(1)}×`;
      statusFps.textContent  = `${Math.round(scene.fps)} fps`;
      opts.environmentTool.syncAnimatedControls();
    }

    requestAnimationFrame(updateReadouts);
  }
  requestAnimationFrame(updateReadouts);
}
