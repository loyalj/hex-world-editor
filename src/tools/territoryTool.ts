import { buildChipRow, wireBrushGroup, wireOptionGroup } from '../ui/uiHelpers.ts';
import { BrushTool } from './brushTool.ts';
import { brushCells, clearMetadataKey } from './tool.ts';
import type { ToolContext, ToolId } from './tool.ts';

type TerritoryMode = 'claim' | 'release';

/**
 * Faction ownership paint. Written through the map transaction rather than
 * TerritoryLayer.claim(), so the metadata snapshot lands in the undo stack
 * with everything else.
 */
export class TerritoryTool extends BrushTool {
  readonly id: ToolId = 'paint-territory';
  readonly title = 'Territory';
  readonly panel = document.getElementById('territory-options') as HTMLElement;

  private factionId: string;
  private mode: TerritoryMode = 'claim';
  private radius = 0;

  constructor(ctx: ToolContext) {
    super(ctx);
    this.factionId = ctx.scene.factions[0]?.id ?? 'red';
    this.refreshPalette();

    wireBrushGroup('territory-brush-group', r => {
      this.radius = r;
      ctx.syncBrushRadius();
    });
    wireOptionGroup('#territory-mode-group .scatter-type-btn', btn => {
      this.mode = btn.dataset['territoryMode'] as TerritoryMode;
    });

    document.getElementById('territory-clear-faction')!.addEventListener('click', () => {
      const territory = ctx.scene.territory;
      if (!territory) return;
      clearMetadataKey(ctx, territory.ownerKey, (c, r) => territory.ownerOf(c, r) === this.factionId);
    });
    document.getElementById('territory-clear-all')!.addEventListener('click', () => {
      const territory = ctx.scene.territory;
      if (!territory) return;
      clearMetadataKey(ctx, territory.ownerKey, (c, r) => territory.ownerOf(c, r) !== null);
    });
  }

  /** Rebuild the faction swatches — call after the roster is edited. */
  refreshPalette(): void {
    const factions = this.ctx.scene.factions;
    if (!factions.some(f => f.id === this.factionId)) {
      this.factionId = factions[0]?.id ?? 'red';
    }
    const group = document.getElementById('faction-group')!;
    group.className = 'pal-grid';
    group.innerHTML = '';
    for (const faction of this.ctx.scene.factions) {
      const btn = buildChipRow(faction.id, faction.name, faction.color, faction.id === this.factionId, () => {
        this.factionId = faction.id;
        group.querySelectorAll('.swatch-row').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
      });
      group.appendChild(btn);
    }
  }

  override brushRadius(): number { return this.radius; }

  protected applyCell(col: number, row: number): void {
    const territory = this.ctx.scene.territory;
    if (!territory) return;
    const next = this.mode === 'claim' ? this.factionId : undefined;
    if (territory.ownerOf(col, row) === (next ?? null)) return;
    (this.tx ??= this.ctx.scene.map.beginEdit()).setCellData(col, row, territory.ownerKey, next);
    this.gameplayDirty = true;
  }

  statusText(): string {
    if (this.mode === 'release') return `Territory · release · brush ${brushCells(this.radius)}`;
    const name = this.ctx.scene.factions.find(f => f.id === this.factionId)?.name ?? this.factionId;
    return `${name} · claim · brush ${brushCells(this.radius)}`;
  }
}
