import { offsetNeighbor } from '@loyalj/hex-world';
import type { ResourceDescriptor } from '@loyalj/hex-world';
import { EDGE_DIRS } from './hexPath.ts';
import { buildChipRow, wireOptionGroup } from '../ui/uiHelpers.ts';
import { BrushTool } from './brushTool.ts';
import { clearMetadataKey } from './tool.ts';
import type { ToolContext, ToolId } from './tool.ts';

type ResourceMode = 'place' | 'erase';

/**
 * Resource placement, optionally enforcing each type's placement rules.
 * Like territory, writes go through the transaction so they're undoable.
 */
export class ResourceTool extends BrushTool {
  readonly id: ToolId = 'paint-resource';
  readonly title = 'Resources';
  readonly panel = document.getElementById('resource-options') as HTMLElement;

  private resourceId: string;
  private mode: ResourceMode = 'place';
  private respectRules = true;

  constructor(ctx: ToolContext) {
    super(ctx);
    this.resourceId = ctx.scene.resourceDescriptors[0]?.id ?? '';
    this.refreshPalette();

    wireOptionGroup('#resource-mode-group .scatter-type-btn', btn => {
      this.mode = btn.dataset['resourceMode'] as ResourceMode;
    });
    (document.getElementById('resource-rules') as HTMLInputElement).addEventListener('change', e => {
      this.respectRules = (e.target as HTMLInputElement).checked;
    });

    document.getElementById('resource-clear-type')!.addEventListener('click', () => {
      const resources = ctx.scene.resources;
      if (!resources) return;
      clearMetadataKey(ctx, resources.resourceKey, (c, r) => resources.resourceAt(c, r) === this.resourceId);
    });
    document.getElementById('resource-clear-all')!.addEventListener('click', () => {
      const resources = ctx.scene.resources;
      if (!resources) return;
      clearMetadataKey(ctx, resources.resourceKey, (c, r) => resources.resourceAt(c, r) !== null);
    });
  }

  /** Rebuild the resource swatches — call after the type set is edited. */
  refreshPalette(): void {
    const descriptors = this.ctx.scene.resourceDescriptors;
    if (!descriptors.some(d => d.id === this.resourceId)) {
      this.resourceId = descriptors[0]?.id ?? '';
    }
    const group = document.getElementById('resource-group')!;
    group.className = 'pal-grid';
    group.innerHTML = '';
    for (const desc of this.ctx.scene.resourceDescriptors) {
      const btn = buildChipRow(desc.id, desc.name, desc.color, desc.id === this.resourceId, () => {
        this.resourceId = desc.id;
        group.querySelectorAll('.swatch-row').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
      });
      group.appendChild(btn);
    }
  }

  /**
   * Whether a resource type's placement rule admits this cell. Covers the rules
   * that read from the map itself; the climate-gated ones (temperature,
   * moisture) need generator fields the editor doesn't carry, so they are not
   * enforced here.
   */
  private canPlace(desc: ResourceDescriptor, col: number, row: number): boolean {
    const rule = desc.placement;
    if (!rule) return true;
    const { map } = this.ctx.scene;

    const terrain = map.getTerrain(col, row);
    const liquid  = this.ctx.scene.isWater(terrain);
    if (rule.requiresLiquid && !liquid) return false;
    if (!rule.requiresLiquid && liquid) return false;
    if (rule.allowedTerrains && !rule.allowedTerrains.includes(terrain)) return false;

    const elevation = map.getElevation(col, row);
    if (rule.minElevation !== undefined && elevation < rule.minElevation) return false;
    if (rule.maxElevation !== undefined && elevation > rule.maxElevation) return false;

    if (rule.requiresRiver && !map.hasRiver(col, row)) return false;
    if (rule.requiresCoast) {
      let coastal = false;
      for (let d = 0; d < 6; d++) {
        const nb = offsetNeighbor(col, row, EDGE_DIRS[d]);
        if (nb.col < 0 || nb.col >= map.width || nb.row < 0 || nb.row >= map.height) continue;
        if (this.ctx.scene.isWater(map.getTerrain(nb.col, nb.row))) { coastal = true; break; }
      }
      if (!coastal) return false;
    }
    if (rule.minFeatureLevel
      && map.getFeatureLevel(col, row, rule.minFeatureLevel.layer) < rule.minFeatureLevel.level) return false;

    return true;
  }

  protected applyCell(col: number, row: number): void {
    const resources = this.ctx.scene.resources;
    if (!resources) return;
    const prev = resources.resourceAt(col, row);
    if (this.mode === 'erase') {
      if (prev === null) return;
      (this.tx ??= this.ctx.scene.map.beginEdit()).setCellData(col, row, resources.resourceKey, undefined);
    } else {
      if (!this.resourceId || prev === this.resourceId) return;
      const desc = resources.getDescriptor(this.resourceId);
      if (!desc) return;
      if (this.respectRules && !this.canPlace(desc, col, row)) return;
      (this.tx ??= this.ctx.scene.map.beginEdit()).setCellData(col, row, resources.resourceKey, this.resourceId);
    }
    this.gameplayDirty = true;
  }

  statusText(): string {
    if (this.mode === 'erase') return 'Resources · erase';
    const name = this.ctx.scene.resourceDescriptors.find(d => d.id === this.resourceId)?.name ?? this.resourceId;
    return `${name} · place${this.respectRules ? '' : ' · anywhere'}`;
  }
}
