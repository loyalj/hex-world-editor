import { wireBrushGroup, wireOptionGroup } from '../ui/uiHelpers.ts';
import { BrushTool } from './brushTool.ts';
import { brushCells } from './tool.ts';
import type { ToolContext, ToolId } from './tool.ts';

type FogMode = 'reveal' | 'hide';

/** The fog panel plus the map's exploration bitmask, for save files. */
export interface FogState {
  enabled: boolean;
  hideUnexplored: boolean;
  dimExplored: boolean;
  /** Base64 exploration bitmask from the scene, or null when never touched. */
  explored: string | null;
}

/**
 * Fog-of-war exploration brush. Exploration is per-player state rather than
 * map data: it is not part of the map's channels, so it stays out of the undo
 * stack too — the base class simply never sees a transaction to commit.
 */
export class FogTool extends BrushTool {
  readonly id: ToolId = 'paint-fog';
  readonly title = 'Fog of war';
  readonly panel = document.getElementById('fog-options') as HTMLElement;
  /** Exploration is per-player state, not map content — locks don't apply. */
  readonly ignoresLocks = true;

  private mode: FogMode = 'reveal';
  private radius = 1;

  /** Capture panel + exploration for a save file. Assigned in the constructor. */
  snapshot!: () => FogState;
  /** Restore a saved fog state (call after the map it belongs to is in place). */
  restore!: (state: FogState) => void;

  constructor(ctx: ToolContext) {
    super(ctx);
    const scene = ctx.scene;
    const fogEnableEl = document.getElementById('fog-enable')          as HTMLInputElement;
    const fogHideEl   = document.getElementById('fog-hide-unexplored') as HTMLInputElement;
    const fogDimEl    = document.getElementById('fog-dim-explored')    as HTMLInputElement;

    /** The brush and the bulk buttons do nothing visible until fog is switched on. */
    const modeBtns = wireOptionGroup('#fog-mode-group .scatter-type-btn', btn => {
      this.mode = btn.dataset['fogMode'] as FogMode;
    });
    const updateFogControls = (): void => {
      const on = fogEnableEl.checked;
      fogHideEl.disabled = !on;
      fogDimEl.disabled  = !on;
      modeBtns.forEach(b => { b.disabled = !on; });
      document.getElementById('fog-reveal-all')!.toggleAttribute('disabled', !on);
      document.getElementById('fog-clear-all')!.toggleAttribute('disabled', !on);
    };

    fogEnableEl.addEventListener('change', () => {
      scene.setFogEnabled(fogEnableEl.checked);
      updateFogControls();
      ctx.minimapInvalidate();
    });
    fogHideEl.addEventListener('change', () => {
      scene.setHideUnexplored(fogHideEl.checked);
      ctx.minimapInvalidate();
    });
    fogDimEl.addEventListener('change', () => {
      scene.setDimExplored(fogDimEl.checked);
      ctx.minimapInvalidate();
    });

    wireBrushGroup('fog-brush-group', r => {
      this.radius = r;
      ctx.syncBrushRadius();
    });

    document.getElementById('fog-reveal-all')!.addEventListener('click', () => {
      scene.setAllFog(true);
      ctx.minimapInvalidate();
      ctx.noteSettingsChanged();
    });
    document.getElementById('fog-clear-all')!.addEventListener('click', () => {
      scene.setAllFog(false);
      ctx.minimapInvalidate();
      ctx.noteSettingsChanged();
    });

    updateFogControls();

    this.snapshot = () => ({
      enabled:        fogEnableEl.checked,
      hideUnexplored: fogHideEl.checked,
      dimExplored:    fogDimEl.checked,
      explored:       scene.fogExploredBase64(),
    });

    this.restore = (st: FogState) => {
      // Exploration first — enabling the layer below attaches whatever the
      // fog data holds at that moment.
      if (st.explored) scene.setFogExplored(st.explored);
      fogHideEl.checked = st.hideUnexplored;
      fogHideEl.dispatchEvent(new Event('change'));
      fogDimEl.checked = st.dimExplored;
      fogDimEl.dispatchEvent(new Event('change'));
      fogEnableEl.checked = st.enabled;
      fogEnableEl.dispatchEvent(new Event('change'));
    };
  }

  override brushRadius(): number { return this.radius; }

  protected override cellEditable(col: number, row: number): boolean {
    return this.ctx.scene.selection.allows(col, row);
  }

  protected applyCell(col: number, row: number): void {
    // No-op rather than painting into a detached fog: with the layer off
    // nothing would change on screen, which reads as a broken brush.
    if (!this.ctx.scene.fog) return;
    this.ctx.scene.paintFog([{ col, row }], this.mode === 'reveal');
    // Exploration stays out of the undo stack but travels in the save file.
    this.ctx.noteSettingsChanged();
  }

  statusText(): string {
    const { explored, total } = this.ctx.scene.fogStats;
    const pct = total > 0 ? Math.round((explored / total) * 100) : 0;
    return `Fog · ${this.mode} · brush ${brushCells(this.radius)} · ${pct}% explored`;
  }
}
