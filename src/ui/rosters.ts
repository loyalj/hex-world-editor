import { DEFAULT_RESOURCE_DESCRIPTORS } from '@loyalj/hex-world';
import type {
  FactionDescriptor, ResourceDescriptor, ResourcePlacementRule, TerrainDescriptor,
} from '@loyalj/hex-world';
import { DEFAULT_FACTIONS } from '../scene.ts';
import { clearMetadataKey } from '../tools/tool.ts';
import type { ToolContext } from '../tools/tool.ts';
import type { TerritoryTool } from '../tools/territoryTool.ts';
import type { ResourceTool } from '../tools/resourceTool.ts';
import type { UnitTool } from '../tools/unitTool.ts';

export interface RostersOptions {
  ctx: ToolContext;
  territoryTool: TerritoryTool;
  resourceTool: ResourceTool;
  unitTool: UnitTool;
  /** Live terrain palette, for the allowed-terrain chips in the resource dialog. */
  terrains(): TerrainDescriptor[];
}

/**
 * Faction and resource *type* management: the Factions and Resource Types
 * dialogs and the roster state behind them. Cell data (who owns what, which
 * deposit sits where) stays on the map; these are the descriptor sets that
 * data refers to, and what a save file or pack records for them.
 */
export interface RostersApi {
  /** The current faction roster — what a save file records. */
  readonly factions: FactionDescriptor[];
  /** The current resource type set — what a save file records. */
  readonly resourceTypes: ResourceDescriptor[];
  openFactionDialog(): void;
  openResourceDialog(): void;
  /**
   * Adopt rosters from a loaded save or pack. Empty arrays fall back to the
   * editor defaults, matching how the terrain palette treats a file that
   * carries no descriptors.
   */
  applyLoaded(factions: FactionDescriptor[], resourceTypes: ResourceDescriptor[]): void;
}

const cssHex = (c: number): string => `#${c.toString(16).padStart(6, '0')}`;
const hexNum = (v: string): number => parseInt(v.slice(1), 16);

/** Unique kebab-case id from a display name — same scheme as the liquid dialog. */
function slugId(name: string, taken: (id: string) => boolean): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'x';
  if (!taken(base)) return base;
  let n = 2;
  while (taken(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

/**
 * "food: 2, gold: 1" → a yields record. `undefined` for an empty string,
 * `null` when some entry doesn't parse (the caller alerts instead of silently
 * dropping what the user typed).
 */
export function parseYields(text: string): Record<string, number> | undefined | null {
  const out: Record<string, number> = {};
  let any = false;
  for (const part of text.split(',')) {
    const entry = part.trim();
    if (!entry) continue;
    const m = /^([A-Za-z][\w-]*)\s*:\s*(-?\d+(?:\.\d+)?)$/.exec(entry);
    if (!m) return null;
    out[m[1]] = parseFloat(m[2]);
    any = true;
  }
  return any ? out : undefined;
}

/** A yields record back to the "food: 2, gold: 1" form the input shows. */
export function formatYields(yields: Record<string, number> | undefined): string {
  if (!yields) return '';
  return Object.entries(yields).map(([k, v]) => `${k}: ${v}`).join(', ');
}

export function initRosters(opts: RostersOptions): RostersApi {
  const { ctx, territoryTool, resourceTool, unitTool } = opts;
  const { scene } = ctx;

  // ---- State ----
  // Start from what the scene was built with, so there is one source of truth
  // at startup. Edits always build fresh arrays/objects; the DEFAULT_* module
  // constants are never mutated through these.
  let factions:      FactionDescriptor[] = [...scene.factions];
  let resourceTypes: ResourceDescriptor[] = [...scene.resourceDescriptors];

  function pushFactions(): void {
    scene.setFactions(factions);
    territoryTool.refreshPalette();
    unitTool.refreshPalette();
    // Unit markers are tinted by faction, so a roster edit recolours them.
    scene.refreshGameplayLayers();
    // Faction tints ride into the minimap through the territory layer.
    ctx.minimapInvalidate();
  }

  function pushResources(): void {
    scene.setResourceDescriptors(resourceTypes);
    resourceTool.refreshPalette();
  }

  // ---- Faction dialog ----
  const factionDialog    = document.getElementById('faction-dialog')        as HTMLDialogElement;
  const factionCloseBtn  = document.getElementById('faction-close-btn')     as HTMLButtonElement;
  const factionSelect    = document.getElementById('faction-select')        as HTMLSelectElement;
  const factionName      = document.getElementById('faction-name')          as HTMLInputElement;
  const factionColor     = document.getElementById('faction-color')         as HTMLInputElement;
  const factionColorLbl  = document.getElementById('faction-color-label')   as HTMLElement;
  const factionBorderChk = document.getElementById('faction-border-custom') as HTMLInputElement;
  const factionBorder    = document.getElementById('faction-border')        as HTMLInputElement;
  const factionBorderLbl = document.getElementById('faction-border-label')  as HTMLElement;
  const factionApplyBtn  = document.getElementById('faction-apply-btn')     as HTMLButtonElement;
  const factionDeleteBtn = document.getElementById('faction-delete-btn')    as HTMLButtonElement;

  function refreshFactionOptions(selected?: string): void {
    factionSelect.innerHTML = '';
    for (const f of factions) {
      const opt = document.createElement('option');
      opt.value = f.id;
      opt.textContent = f.name;
      factionSelect.appendChild(opt);
    }
    const newOpt = document.createElement('option');
    newOpt.value = '__new';
    newOpt.textContent = '+ New faction…';
    factionSelect.appendChild(newOpt);
    factionSelect.value = selected && factions.some(f => f.id === selected)
      ? selected
      : factions[0]?.id ?? '__new';
  }

  function syncBorderRow(): void {
    factionBorder.disabled = !factionBorderChk.checked;
    factionBorderLbl.textContent = factionBorderChk.checked ? factionBorder.value : '—';
  }

  function loadFactionForm(id: string): void {
    const f = factions.find(x => x.id === id);
    factionName.value  = f?.name ?? '';
    factionColor.value = cssHex(f?.color ?? 0xdd4433);
    factionColorLbl.textContent = factionColor.value;
    factionBorderChk.checked = f?.borderColor !== undefined;
    factionBorder.value = cssHex(f?.borderColor ?? f?.color ?? 0xdd4433);
    syncBorderRow();
    factionDeleteBtn.disabled = !f;
  }

  factionCloseBtn.addEventListener('click', () => factionDialog.close());
  factionDialog.addEventListener('click', e => { if (e.target === factionDialog) factionDialog.close(); });
  factionSelect.addEventListener('change', () => loadFactionForm(factionSelect.value));
  factionColor.addEventListener('input', () => { factionColorLbl.textContent = factionColor.value; });
  factionBorderChk.addEventListener('change', syncBorderRow);
  factionBorder.addEventListener('input', syncBorderRow);

  factionApplyBtn.addEventListener('click', () => {
    const name = factionName.value.trim();
    if (!name) { alert('Please enter a faction name.'); return; }
    const isNew = factionSelect.value === '__new';
    const id    = isNew ? slugId(name, x => factions.some(f => f.id === x)) : factionSelect.value;

    const existing = factions.find(f => f.id === id);
    const updated: FactionDescriptor = { ...existing, id, name, color: hexNum(factionColor.value) };
    if (factionBorderChk.checked) updated.borderColor = hexNum(factionBorder.value);
    else delete updated.borderColor;

    const idx = factions.findIndex(f => f.id === id);
    factions = idx >= 0
      ? [...factions.slice(0, idx), updated, ...factions.slice(idx + 1)]
      : [...factions, updated];

    pushFactions();
    ctx.noteSettingsChanged();
    refreshFactionOptions(id);
    loadFactionForm(id);
  });

  factionDeleteBtn.addEventListener('click', () => {
    const id = factionSelect.value;
    const f  = factions.find(x => x.id === id);
    if (!f) return;
    if (factions.length === 1) { alert('Keep at least one faction.'); return; }
    if (!confirm(`Delete "${f.name}"? Cells it owns will be released (undoable).`)) return;

    // Release its cells first, as one undoable edit — an undo brings the cells
    // back with an off-roster owner, which simply stops drawing.
    const territory = scene.territory;
    if (territory) {
      clearMetadataKey(ctx, territory.ownerKey, (c, r) => territory.ownerOf(c, r) === id);
    }
    factions = factions.filter(x => x.id !== id);
    pushFactions();
    ctx.noteSettingsChanged();
    refreshFactionOptions();
    loadFactionForm(factionSelect.value);
  });

  function openFactionDialog(): void {
    refreshFactionOptions();
    loadFactionForm(factionSelect.value);
    factionDialog.showModal();
  }

  // ---- Resource dialog ----
  const resourceDialog   = document.getElementById('resource-dialog')        as HTMLDialogElement;
  const resourceCloseBtn = document.getElementById('resource-close-btn')     as HTMLButtonElement;
  const resourceSelect   = document.getElementById('resource-select')        as HTMLSelectElement;
  const resourceName     = document.getElementById('resource-name')          as HTMLInputElement;
  const resourceColor    = document.getElementById('resource-color')         as HTMLInputElement;
  const resourceColorLbl = document.getElementById('resource-color-label')   as HTMLElement;
  const resourceYields   = document.getElementById('resource-yields')        as HTMLInputElement;
  const resourceTerrains = document.getElementById('resource-terrains')      as HTMLElement;
  const resElevMin       = document.getElementById('resource-elev-min')      as HTMLInputElement;
  const resElevMax       = document.getElementById('resource-elev-max')      as HTMLInputElement;
  const resReqLiquid     = document.getElementById('resource-req-liquid')    as HTMLInputElement;
  const resReqCoast      = document.getElementById('resource-req-coast')     as HTMLInputElement;
  const resReqRiver      = document.getElementById('resource-req-river')     as HTMLInputElement;
  const resFeatureLayer  = document.getElementById('resource-feature-layer') as HTMLSelectElement;
  const resFeatureLevel  = document.getElementById('resource-feature-level') as HTMLSelectElement;
  const resFrequency     = document.getElementById('resource-frequency')     as HTMLInputElement;
  const resSpacing       = document.getElementById('resource-spacing')       as HTMLInputElement;
  const resourceApplyBtn  = document.getElementById('resource-apply-btn')    as HTMLButtonElement;
  const resourceDeleteBtn = document.getElementById('resource-delete-btn')   as HTMLButtonElement;

  /** Terrain indices toggled on in the allowed-terrain chip grid. */
  const allowedTerrains = new Set<number>();

  function renderTerrainChips(): void {
    resourceTerrains.innerHTML = '';
    for (const desc of opts.terrains()) {
      const btn = document.createElement('button');
      btn.className = 'terrain-filter-btn';
      btn.title = desc.name;
      btn.style.background = cssHex(desc.color);
      if (allowedTerrains.has(desc.index)) btn.classList.add('active');
      btn.addEventListener('click', () => {
        if (allowedTerrains.has(desc.index)) {
          allowedTerrains.delete(desc.index);
          btn.classList.remove('active');
        } else {
          allowedTerrains.add(desc.index);
          btn.classList.add('active');
        }
      });
      resourceTerrains.appendChild(btn);
    }
  }

  function refreshResourceOptions(selected?: string): void {
    resourceSelect.innerHTML = '';
    for (const d of resourceTypes) {
      const opt = document.createElement('option');
      opt.value = d.id;
      opt.textContent = d.name;
      resourceSelect.appendChild(opt);
    }
    const newOpt = document.createElement('option');
    newOpt.value = '__new';
    newOpt.textContent = '+ New resource…';
    resourceSelect.appendChild(newOpt);
    resourceSelect.value = selected && resourceTypes.some(d => d.id === selected)
      ? selected
      : resourceTypes[0]?.id ?? '__new';
  }

  function loadResourceForm(id: string): void {
    const d    = resourceTypes.find(x => x.id === id);
    const rule = d?.placement;
    resourceName.value  = d?.name ?? '';
    resourceColor.value = cssHex(d?.color ?? 0xb0b6c0);
    resourceColorLbl.textContent = resourceColor.value;
    resourceYields.value = formatYields(d?.yields);

    allowedTerrains.clear();
    for (const t of rule?.allowedTerrains ?? []) allowedTerrains.add(t);
    renderTerrainChips();
    resElevMin.value = rule?.minElevation !== undefined ? String(rule.minElevation) : '';
    resElevMax.value = rule?.maxElevation !== undefined ? String(rule.maxElevation) : '';
    resReqLiquid.checked = rule?.requiresLiquid === true;
    resReqCoast.checked  = rule?.requiresCoast  === true;
    resReqRiver.checked  = rule?.requiresRiver  === true;
    resFeatureLayer.value = rule?.minFeatureLevel ? String(rule.minFeatureLevel.layer) : '';
    resFeatureLevel.value = rule?.minFeatureLevel ? String(rule.minFeatureLevel.level) : '1';
    resFrequency.value = rule?.frequency  !== undefined ? String(rule.frequency)  : '';
    resSpacing.value   = rule?.minSpacing !== undefined ? String(rule.minSpacing) : '';
    resourceDeleteBtn.disabled = !d;
  }

  /**
   * The placement rule the form describes, or `undefined` when every field is
   * unset — no rule at all is how "place anywhere" is spelled. The climate
   * fields have no form inputs (the editor carries no temperature/moisture
   * data), so an existing rule's values are carried over untouched.
   */
  function buildPlacement(existing?: ResourcePlacementRule): ResourcePlacementRule | undefined {
    const rule: ResourcePlacementRule = {};
    if (allowedTerrains.size > 0) rule.allowedTerrains = [...allowedTerrains].sort((a, b) => a - b);
    if (resElevMin.value.trim() !== '') rule.minElevation = parseInt(resElevMin.value, 10);
    if (resElevMax.value.trim() !== '') rule.maxElevation = parseInt(resElevMax.value, 10);
    if (resReqLiquid.checked) rule.requiresLiquid = true;
    if (resReqCoast.checked)  rule.requiresCoast  = true;
    if (resReqRiver.checked)  rule.requiresRiver  = true;
    if (resFeatureLayer.value !== '') {
      rule.minFeatureLevel = {
        layer: parseInt(resFeatureLayer.value, 10),
        level: parseInt(resFeatureLevel.value, 10),
      };
    }
    if (resFrequency.value.trim() !== '') {
      rule.frequency = Math.min(1, Math.max(0, parseFloat(resFrequency.value) || 0));
    }
    if (resSpacing.value.trim() !== '') {
      rule.minSpacing = Math.max(0, parseInt(resSpacing.value, 10) || 0);
    }
    if (existing) {
      if (existing.minTemperature !== undefined) rule.minTemperature = existing.minTemperature;
      if (existing.maxTemperature !== undefined) rule.maxTemperature = existing.maxTemperature;
      if (existing.minMoisture    !== undefined) rule.minMoisture    = existing.minMoisture;
      if (existing.maxMoisture    !== undefined) rule.maxMoisture    = existing.maxMoisture;
    }
    return Object.keys(rule).length > 0 ? rule : undefined;
  }

  resourceCloseBtn.addEventListener('click', () => resourceDialog.close());
  resourceDialog.addEventListener('click', e => { if (e.target === resourceDialog) resourceDialog.close(); });
  resourceSelect.addEventListener('change', () => loadResourceForm(resourceSelect.value));
  resourceColor.addEventListener('input', () => { resourceColorLbl.textContent = resourceColor.value; });

  resourceApplyBtn.addEventListener('click', () => {
    const name = resourceName.value.trim();
    if (!name) { alert('Please enter a resource name.'); return; }
    const yields = parseYields(resourceYields.value);
    if (yields === null) {
      alert('Yields should look like "food: 2, gold: 1".');
      return;
    }
    const isNew = resourceSelect.value === '__new';
    const id    = isNew ? slugId(name, x => resourceTypes.some(d => d.id === x)) : resourceSelect.value;

    // Spread the existing descriptor so fields the form doesn't edit
    // (iconAssetId, size, yOffset) survive a rename.
    const existing = resourceTypes.find(d => d.id === id);
    const updated: ResourceDescriptor = { ...existing, id, name, color: hexNum(resourceColor.value) };
    const placement = buildPlacement(existing?.placement);
    if (placement) updated.placement = placement; else delete updated.placement;
    if (yields) updated.yields = yields; else delete updated.yields;

    const idx = resourceTypes.findIndex(d => d.id === id);
    resourceTypes = idx >= 0
      ? [...resourceTypes.slice(0, idx), updated, ...resourceTypes.slice(idx + 1)]
      : [...resourceTypes, updated];

    pushResources();
    ctx.noteSettingsChanged();
    refreshResourceOptions(id);
    loadResourceForm(id);
  });

  resourceDeleteBtn.addEventListener('click', () => {
    const id = resourceSelect.value;
    const d  = resourceTypes.find(x => x.id === id);
    if (!d) return;
    if (resourceTypes.length === 1) { alert('Keep at least one resource type.'); return; }
    if (!confirm(`Delete "${d.name}"? Its deposits on the map will be removed (undoable).`)) return;

    const resources = scene.resources;
    if (resources) {
      clearMetadataKey(ctx, resources.resourceKey, (c, r) => resources.resourceAt(c, r) === id);
    }
    resourceTypes = resourceTypes.filter(x => x.id !== id);
    pushResources();
    ctx.noteSettingsChanged();
    refreshResourceOptions();
    loadResourceForm(resourceSelect.value);
  });

  function openResourceDialog(): void {
    refreshResourceOptions();
    loadResourceForm(resourceSelect.value);
    resourceDialog.showModal();
  }

  // ---- Menu entry points ----
  (document.getElementById('factions-menu-btn') as HTMLButtonElement)
    .addEventListener('click', openFactionDialog);
  (document.getElementById('resources-menu-btn') as HTMLButtonElement)
    .addEventListener('click', openResourceDialog);

  return {
    get factions() { return factions; },
    get resourceTypes() { return resourceTypes; },
    openFactionDialog,
    openResourceDialog,
    applyLoaded(loadedFactions, loadedResourceTypes) {
      factions      = loadedFactions.length      > 0 ? loadedFactions      : [...DEFAULT_FACTIONS];
      resourceTypes = loadedResourceTypes.length > 0 ? loadedResourceTypes
                                                     : structuredClone(DEFAULT_RESOURCE_DESCRIPTORS);
      pushFactions();
      pushResources();
    },
  };
}
