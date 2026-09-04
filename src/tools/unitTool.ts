import { buildChipRow, wireOptionGroup } from '../ui/uiHelpers.ts';
import { UNIT_KEY, UNIT_TYPES, unitAt } from '../unitTypes.ts';
import { BrushTool } from './brushTool.ts';
import { clearMetadataKey } from './tool.ts';
import type { ToolContext, ToolId } from './tool.ts';

type UnitMode = 'place' | 'erase';

/**
 * Unit placement: one unit per cell, stored in the metadata channel like
 * ownership and resources, so placement is undoable and rides through saves
 * and packs untouched. Land units place only on land and ships only on water
 * — the one placement rule units carry. The scene's unit layer renders the
 * markers, silhouette by type and colour by owning faction.
 */
export class UnitTool extends BrushTool {
  readonly id: ToolId = 'paint-unit';
  readonly title = 'Units';
  readonly panel = document.getElementById('unit-options') as HTMLElement;

  private typeId: string;
  private factionId: string;
  private mode: UnitMode = 'place';

  constructor(ctx: ToolContext) {
    super(ctx);
    this.typeId    = UNIT_TYPES[0].id;
    this.factionId = ctx.scene.factions[0]?.id ?? 'red';
    this.renderTypePalette();
    this.refreshPalette();

    wireOptionGroup('#unit-mode-group .scatter-type-btn', btn => {
      this.mode = btn.dataset['unitMode'] as UnitMode;
    });

    document.getElementById('unit-clear-all')!.addEventListener('click', () => {
      clearMetadataKey(ctx, UNIT_KEY, (c, r) => unitAt(ctx.scene.map, c, r) !== null);
    });
  }

  private renderTypePalette(): void {
    const group = document.getElementById('unit-type-group')!;
    group.className = 'pal-grid';
    group.innerHTML = '';
    for (const desc of UNIT_TYPES) {
      const btn = buildChipRow(desc.id, desc.name, desc.color, desc.id === this.typeId, () => {
        this.typeId = desc.id;
        group.querySelectorAll('.swatch-row').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
      });
      group.appendChild(btn);
    }
  }

  /** Rebuild the faction swatches — call after the roster is edited. */
  refreshPalette(): void {
    const factions = this.ctx.scene.factions;
    if (!factions.some(f => f.id === this.factionId)) {
      this.factionId = factions[0]?.id ?? 'red';
    }
    const group = document.getElementById('unit-faction-group')!;
    group.className = 'pal-grid';
    group.innerHTML = '';
    for (const faction of factions) {
      const btn = buildChipRow(faction.id, faction.name, faction.color, faction.id === this.factionId, () => {
        this.factionId = faction.id;
        group.querySelectorAll('.swatch-row').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
      });
      group.appendChild(btn);
    }
  }

  protected applyCell(col: number, row: number): void {
    const { map } = this.ctx.scene;
    const prev = unitAt(map, col, row);
    if (this.mode === 'erase') {
      if (!prev) return;
      (this.tx ??= map.beginEdit()).setCellData(col, row, UNIT_KEY, undefined);
    } else {
      const desc = UNIT_TYPES.find(d => d.id === this.typeId);
      if (!desc) return;
      // The one placement rule: ships on water, everything else on land.
      if (desc.naval !== this.ctx.scene.isWater(map.getTerrain(col, row))) return;
      if (prev && prev.type === this.typeId && prev.faction === this.factionId) return;
      (this.tx ??= map.beginEdit())
        .setCellData(col, row, UNIT_KEY, { type: this.typeId, faction: this.factionId });
    }
    this.gameplayDirty = true;
  }

  statusText(): string {
    if (this.mode === 'erase') return 'Units · erase';
    const type    = UNIT_TYPES.find(d => d.id === this.typeId)?.name ?? this.typeId;
    const faction = this.ctx.scene.factions.find(f => f.id === this.factionId)?.name ?? this.factionId;
    return `${type} · ${faction} · place`;
  }
}
