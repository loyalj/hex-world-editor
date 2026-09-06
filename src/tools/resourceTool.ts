import { offsetNeighbor, offsetToHex } from '@loyalj/hex-world';
import type { ResourceDescriptor } from '@loyalj/hex-world';
import { EDGE_DIRS, hexDistance } from './hexPath.ts';
import { buildChipRow, wireOptionGroup } from '../ui/uiHelpers.ts';
import { SCATTER_LAYER_NAMES } from '../scatterRoster.ts';
import { BrushTool } from './brushTool.ts';
import { clearMetadataKey } from './tool.ts';
import type { CellPos, ToolContext, ToolId } from './tool.ts';

type ResourceMode = 'place' | 'erase';

/**
 * Resource placement, optionally enforcing each type's placement rules —
 * and saying which rule refused a cell, rather than silently skipping it.
 * Like territory, writes go through the transaction so they're undoable.
 * Beyond the brush: a highlight of every cell the chosen type's rules
 * allow, a scatter that drops N of the type at random across the selection
 * (rules and spacing respected), and Alt+click to sample the resource under
 * the cursor. Per-type counts live in the Resources panel.
 */
export class ResourceTool extends BrushTool {
  readonly id: ToolId = 'paint-resource';
  readonly title = 'Resources';
  readonly panel = document.getElementById('resource-options') as HTMLElement;
  readonly hasEyedropper = true;

  private resourceId: string;
  private mode: ResourceMode = 'place';
  private respectRules = true;
  private highlightOn = false;
  private scatterCount = 10;
  /** What the last panel action did, for the status strip — cleared by the next click on the map. */
  private lastAction: string | null = null;

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
    (document.getElementById('resource-highlight') as HTMLInputElement).addEventListener('change', e => {
      this.highlightOn = (e.target as HTMLInputElement).checked;
      this.refreshHighlight();
    });
    (document.getElementById('resource-scatter-count') as HTMLInputElement).addEventListener('input', e => {
      this.scatterCount = Math.max(1, parseInt((e.target as HTMLInputElement).value, 10) || 1);
    });
    document.getElementById('resource-scatter-btn')!.addEventListener('click', () => this.scatter());

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
        this.setResource(desc.id);
      });
      group.appendChild(btn);
    }
    this.refreshHighlight();
  }

  /** Pick the paint resource and sweep the swatches to match. */
  private setResource(id: string): void {
    this.resourceId = id;
    document.querySelectorAll<HTMLButtonElement>('#resource-group .swatch-row')
      .forEach(b => b.classList.toggle('active', b.dataset['id'] === id));
    this.refreshHighlight();
  }

  private descriptor(): ResourceDescriptor | undefined {
    return this.ctx.scene.resourceDescriptors.find(d => d.id === this.resourceId);
  }

  /** Alt+click samples the resource under the cursor into the palette; a bare cell samples nothing. */
  private eyedrop(cell: CellPos, e: PointerEvent): void {
    e.preventDefault();
    const id = this.ctx.scene.resources?.resourceAt(cell.col, cell.row) ?? null;
    if (id === null || !this.ctx.scene.resourceDescriptors.some(d => d.id === id)) return;
    this.setResource(id);
  }

  override pointerDown(cell: CellPos, e: PointerEvent): void {
    this.lastAction = null;
    if (e.altKey) {
      this.eyedrop(cell, e);
      return;
    }
    super.pointerDown(cell, e);
  }

  // ---- Placement rules ----

  /**
   * Why a resource type's placement rule refuses this cell, or null when it
   * admits it. Covers the rules that read from the map itself; the
   * climate-gated ones (temperature, moisture) need generator fields the
   * editor doesn't carry, so they are not enforced here. The first failing
   * rule is the one reported, in the order a map-maker would fix them.
   */
  placementRefusal(desc: ResourceDescriptor, col: number, row: number): string | null {
    const rule = desc.placement;
    if (!rule) return null;
    const scene = this.ctx.scene;
    const { map } = scene;

    const terrain = map.getTerrain(col, row);
    const liquid  = scene.isWater(terrain);
    if (rule.requiresLiquid && !liquid) return 'needs open water';
    if (!rule.requiresLiquid && liquid) return 'needs solid ground';
    if (rule.allowedTerrains && !rule.allowedTerrains.includes(terrain)) {
      const names = rule.allowedTerrains.map(t => scene.terrainLookup.get(t)?.name ?? `terrain ${t}`);
      const list = names.length <= 3 ? names.join(', ') : `${names.slice(0, 3).join(', ')} +${names.length - 3}`;
      return `needs ${list}`;
    }

    const elevation = map.getElevation(col, row);
    if (rule.minElevation !== undefined && elevation < rule.minElevation) {
      return `needs elevation ≥ ${rule.minElevation} (here ${elevation})`;
    }
    if (rule.maxElevation !== undefined && elevation > rule.maxElevation) {
      return `needs elevation ≤ ${rule.maxElevation} (here ${elevation})`;
    }

    if (rule.requiresRiver && !map.hasRiver(col, row)) return 'needs a river';
    if (rule.requiresCoast) {
      let coastal = false;
      for (let d = 0; d < 6; d++) {
        const nb = offsetNeighbor(col, row, EDGE_DIRS[d]);
        if (!map.inBounds(nb.col, nb.row)) continue;
        if (scene.isWater(map.getTerrain(nb.col, nb.row))) { coastal = true; break; }
      }
      if (!coastal) return 'needs to touch water';
    }
    if (rule.minFeatureLevel) {
      const { layer, level } = rule.minFeatureLevel;
      if (map.getFeatureLevel(col, row, layer) < level) {
        return `needs ${SCATTER_LAYER_NAMES[layer]?.toLowerCase() ?? `layer ${layer}`} density ≥ ${level}`;
      }
    }
    return null;
  }

  /** Whether a resource type's placement rule admits this cell. */
  private canPlace(desc: ResourceDescriptor, col: number, row: number): boolean {
    return this.placementRefusal(desc, col, row) === null;
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

  // ---- Eligibility highlight ----

  /** Every cell the chosen type's rules admit — what the highlight tints. */
  private eligibleCells(): CellPos[] {
    const desc = this.descriptor();
    const { map } = this.ctx.scene;
    const cells: CellPos[] = [];
    if (!desc) return cells;
    for (let row = 0; row < map.height; row++) {
      for (let col = 0; col < map.width; col++) {
        if (this.canPlace(desc, col, row)) cells.push({ col, row });
      }
    }
    return cells;
  }

  /**
   * Redraw (or hide) the eligibility tint. Call after any edit — terrain,
   * elevation, rivers, scatter all move the rules' answer — and on a palette
   * change; the app wires the first from the history, the tool the second.
   */
  refreshHighlight(): void {
    const on = this.highlightOn && !this.panel.classList.contains('hidden');
    this.ctx.scene.setResourceHighlight(on ? this.eligibleCells() : null);
  }

  /** The highlight belongs to this tool alone: it shows while the tool is active and hides when it isn't. */
  activate(): void {
    this.refreshHighlight();
  }

  override deactivate(): void {
    super.deactivate();
    this.ctx.scene.setResourceHighlight(null);
  }

  // ---- Scatter ----

  /**
   * Drop the chosen resource on N randomly picked cells of the selection —
   * or the whole map with nothing selected — as one undo step. Cells already
   * holding a resource are skipped; with rules on, so are cells the rules
   * refuse and cells within the type's minimum spacing of another deposit
   * of it, existing or just placed.
   */
  private scatter(): void {
    const scene = this.ctx.scene;
    const resources = scene.resources;
    const desc = this.descriptor();
    if (!resources || !desc) return;
    const { map } = scene;
    const pool: CellPos[] = scene.selection.size > 0 ? scene.selection.cells() : [];
    if (pool.length === 0) {
      for (let row = 0; row < map.height; row++) {
        for (let col = 0; col < map.width; col++) pool.push({ col, row });
      }
    }
    const candidates = pool.filter(({ col, row }) =>
      scene.editable(col, row)
      && resources.resourceAt(col, row) === null
      && (!this.respectRules || this.canPlace(desc, col, row)));
    // Fisher–Yates over the candidates, then take from the front.
    for (let i = candidates.length - 1; i > 0; i--) {
      const j = Math.floor(this.rng() * (i + 1));
      [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
    }
    const spacing = this.respectRules ? (desc.placement?.minSpacing ?? 0) : 0;
    const placed: CellPos[] = [];
    if (spacing > 0) {
      for (let row = 0; row < map.height; row++) {
        for (let col = 0; col < map.width; col++) {
          if (resources.resourceAt(col, row) === desc.id) placed.push({ col, row });
        }
      }
    }
    const existing = placed.length;
    const tooClose = (c: CellPos): boolean => {
      if (spacing <= 0) return false;
      const h = offsetToHex(c.col, c.row);
      return placed.some(p => hexDistance(h, offsetToHex(p.col, p.row)) < spacing);
    };
    const tx = map.beginEdit();
    for (const c of candidates) {
      if (placed.length - existing >= this.scatterCount) break;
      if (tooClose(c)) continue;
      tx.setCellData(c.col, c.row, resources.resourceKey, desc.id);
      placed.push(c);
    }
    const n = placed.length - existing;
    this.ctx.commitEdit(tx.commit());
    const where = scene.selection.size > 0 ? 'the selection' : 'the map';
    if (n === 0) {
      this.lastAction = candidates.length === 0
        ? `nothing to scatter — no free eligible cell in ${where}`
        : `nothing to scatter — spacing leaves no room in ${where}`;
    } else if (n < this.scatterCount) {
      // Short of the ask: either the eligible cells ran out, or the spacing did.
      this.lastAction = candidates.length <= n
        ? `scattered ${n} of ${this.scatterCount} ${desc.name} — only ${n} free eligible cell${n === 1 ? '' : 's'} in ${where}`
        : `scattered ${n} of ${this.scatterCount} ${desc.name} — spacing left room for no more in ${where}`;
    } else {
      this.lastAction = `scattered ${n} ${desc.name} across ${where}`;
    }
    if (n === 0) return;
    scene.refreshGameplayLayers();
    this.refreshHighlight();
  }

  statusText(): string {
    const note = this.lastAction ? ` · ${this.lastAction}` : '';
    if (this.mode === 'erase') return `Resources · erase${note}`;
    const desc = this.descriptor();
    const name = desc?.name ?? this.resourceId;
    // Say why the cell under the cursor would refuse the paint, so a brush
    // that "does nothing" here reads as a rule, not a bug.
    const hovered = this.ctx.scene.hoveredCell;
    const why = desc && hovered && this.respectRules ? this.placementRefusal(desc, hovered.col, hovered.row) : null;
    const refusal = why ? ` · not here: ${why}` : '';
    return `${name} · place${this.respectRules ? '' : ' · anywhere'}${refusal}${note}`;
  }
}
