import { DEFAULT_TERRAIN_DESCRIPTORS, DEFAULT_LIQUID_DESCRIPTORS } from '@loyalj/hex-world';
import type { TerrainDescriptor, TerrainAssetRegistry, LiquidTypeDescriptor } from '@loyalj/hex-world';
import { buildInfoTip } from './infoTips.ts';
import type { SceneApi } from '../scene.ts';
import type { TerrainTool } from '../tools/terrainTool.ts';
import type { ScatterTool } from '../tools/scatterTool.ts';

// ---- Editor default terrain set ----
// The library ships water as its only liquid terrain; the editor also offers
// lava and acid out of the box, linked to the built-in liquid descriptors.
// Colors match each liquid's shallowColor so palette swatches read correctly.
// Index 6 is the library's built-in riverbed terrain (carved stream-bed
// blending), so editor liquids start at 7.
export const EDITOR_DEFAULT_TERRAINS: TerrainDescriptor[] = [
  ...DEFAULT_TERRAIN_DESCRIPTORS,
  { index: 7, id: 'lava', name: 'Lava', color: 0xd45a10,
    liquidType: 'lava', roadCost: 1, texture: { type: 'procedural' } },
  { index: 8, id: 'acid', name: 'Acid', color: 0x4db318,
    liquidType: 'acid', roadCost: 1, texture: { type: 'procedural' } },
];

export interface PaletteOptions {
  scene: SceneApi;
  terrainTool: TerrainTool;
  scatterTool: ScatterTool;
  minimapInvalidate(): void;
}

/**
 * Terrain and liquid *type* management: the swatch palette in the terrain
 * drawer, the Add/Edit Terrain dialog, and the Liquid Types dialog, plus the
 * descriptor state and image assets behind them. Save/load and pack
 * import/export read the current descriptors from here.
 */
export interface PaletteApi {
  /** The current terrain descriptors — what a save file records. */
  readonly terrains: TerrainDescriptor[];
  /** The current liquid descriptors — what a save file records. */
  readonly liquids: LiquidTypeDescriptor[];
  /** Uploaded terrain texture images, by asset id, for pack export. */
  readonly textureAssets: Map<string, Blob>;
  /** The texture images as data URLs, for embedding in a JSON save. */
  textureAssetsAsDataURLs(): Promise<Record<string, string>>;
  openTerrainDialog(editIndex: number | null, presetLiquid?: string): void;
  openLiquidDialog(): void;
  /**
   * Adopt descriptors from a loaded JSON save (empty arrays fall back to the
   * editor defaults), rebuild the scene's terrain material, and refresh the
   * dependent UI. `images` maps asset ids to data URLs (the editor block of a
   * save file); image-backed textures without an entry fall back to procedural.
   */
  applyLoadedDescriptors(
    terrains: TerrainDescriptor[],
    liquids: LiquidTypeDescriptor[],
    images?: Record<string, string>,
  ): Promise<void>;
  /**
   * Adopt descriptors from an imported HexPack. The pack loader has already
   * applied them to the scene, so this only swaps the state and refreshes UI.
   */
  adoptPackDescriptors(terrains: TerrainDescriptor[], liquids: LiquidTypeDescriptor[]): void;
}

export function initPalette(opts: PaletteOptions): PaletteApi {
  const { scene, terrainTool, scatterTool } = opts;

  // ---- DOM refs ----
  const addTerrainDialog   = document.getElementById('add-terrain-dialog')     as HTMLDialogElement;
  const terrainDialogTitle = document.getElementById('terrain-dialog-title')    as HTMLElement;
  const addTerrainCloseBtw = document.getElementById('add-terrain-close-btn')   as HTMLButtonElement;
  const addTerrainName     = document.getElementById('add-terrain-name')       as HTMLInputElement;
  const addTerrainColor    = document.getElementById('add-terrain-color')      as HTMLInputElement;
  const addTerrainColorLbl = document.getElementById('add-terrain-color-label') as HTMLElement;
  const addTerrainImgBtn   = document.getElementById('add-terrain-img-btn')    as HTMLButtonElement;
  const addTerrainImgInput = document.getElementById('add-terrain-img-input')  as HTMLInputElement;
  const addTerrainImgSt    = document.getElementById('add-terrain-img-status') as HTMLElement;
  const addTerrainCost     = document.getElementById('add-terrain-cost')       as HTMLInputElement;
  const addTerrainLiquid   = document.getElementById('add-terrain-liquid')     as HTMLSelectElement;
  const addTerrainConfirm  = document.getElementById('add-terrain-confirm-btn') as HTMLButtonElement;

  const liquidDialog      = document.getElementById('liquid-dialog')        as HTMLDialogElement;
  const liquidCloseBtn    = document.getElementById('liquid-close-btn')     as HTMLButtonElement;
  const liquidSelect      = document.getElementById('liquid-select')        as HTMLSelectElement;
  const liquidName        = document.getElementById('liquid-name')          as HTMLInputElement;
  const liquidShallow     = document.getElementById('liquid-shallow')       as HTMLInputElement;
  const liquidShallowLbl  = document.getElementById('liquid-shallow-label') as HTMLElement;
  const liquidDeep        = document.getElementById('liquid-deep')          as HTMLInputElement;
  const liquidDeepLbl     = document.getElementById('liquid-deep-label')    as HTMLElement;
  const liquidFoam        = document.getElementById('liquid-foam')          as HTMLInputElement;
  const liquidFoamLbl     = document.getElementById('liquid-foam-label')    as HTMLElement;
  const liquidOpacity     = document.getElementById('liquid-opacity')       as HTMLInputElement;
  const liquidFlow        = document.getElementById('liquid-flow')          as HTMLInputElement;
  const liquidWave        = document.getElementById('liquid-wave')          as HTMLInputElement;
  const liquidFoamInt     = document.getElementById('liquid-foam-int')      as HTMLInputElement;
  const liquidEmissive    = document.getElementById('liquid-emissive')      as HTMLInputElement;
  const liquidEmissiveStr = document.getElementById('liquid-emissive-str')  as HTMLInputElement;
  const liquidApplyBtn    = document.getElementById('liquid-apply-btn')     as HTMLButtonElement;

  // ---- State ----
  let terrainDescriptors: TerrainDescriptor[] = [...EDITOR_DEFAULT_TERRAINS];
  const terrainAssetBlobs    = new Map<string, Blob>();
  const terrainAssetRegistry: TerrainAssetRegistry = new Map();
  let pendingTerrainImage: File | null = null;
  let editingTerrainIndex: number | null = null;
  let liquidDescriptors: LiquidTypeDescriptor[] = structuredClone(DEFAULT_LIQUID_DESCRIPTORS);

  const DEFAULT_TERRAIN_IDS = new Set(DEFAULT_TERRAIN_DESCRIPTORS.map(d => d.id));

  // ---- Terrain palette ----
  function openTerrainDialog(editIndex: number | null, presetLiquid?: string): void {
    editingTerrainIndex = editIndex;
    if (editIndex !== null) {
      const desc = terrainDescriptors.find(d => d.index === editIndex)!;
      terrainDialogTitle.textContent = 'Edit Terrain Type';
      addTerrainConfirm.textContent  = 'Save Changes';
      addTerrainName.value  = desc.name;
      const hex = `#${desc.color.toString(16).padStart(6, '0')}`;
      addTerrainColor.value = hex;
      addTerrainColorLbl.textContent = hex;
      addTerrainCost.value   = String(desc.roadCost ?? 1);
      addTerrainLiquid.value = desc.liquidType ?? '';
      const hasImg = desc.texture.type === 'image'
        && desc.texture.assetId != null
        && terrainAssetRegistry.has(desc.texture.assetId);
      addTerrainImgSt.textContent = hasImg ? 'Using custom image' : 'No image';
      pendingTerrainImage = null;
    } else {
      terrainDialogTitle.textContent = 'Add Terrain Type';
      addTerrainConfirm.textContent  = 'Add Terrain';
      addTerrainName.value  = '';
      addTerrainColor.value = '#7a8a6a';
      addTerrainColorLbl.textContent = '#7a8a6a';
      addTerrainCost.value   = '1';
      addTerrainLiquid.value = presetLiquid ?? '';
      addTerrainImgSt.textContent = 'No image';
      pendingTerrainImage = null;
    }
    addTerrainDialog.showModal();
  }

  /** One swatch row: color chip, name, and a lock toggle that appears on hover. */
  function buildSwatchRow(desc: TerrainDescriptor): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.className = 'swatch-row';
    btn.dataset['terrain'] = String(desc.index);
    if (desc.index === terrainTool.paintTerrain) btn.classList.add('active');
    if (terrainTool.lockedTerrains.has(desc.index)) btn.classList.add('swatch-row--locked');

    const chip = document.createElement('span');
    chip.className = 'swatch-chip';
    chip.style.background = `#${desc.color.toString(16).padStart(6, '0')}`;
    btn.appendChild(chip);

    const name = document.createElement('span');
    name.className = 'swatch-name';
    name.textContent = desc.name;
    btn.appendChild(name);

    const lockEl = document.createElement('span');
    lockEl.className = 'swatch-lock';
    lockEl.title = 'Lock/unlock — locked terrain cannot be painted over';
    lockEl.textContent = '🔒';
    lockEl.addEventListener('click', e => {
      e.stopPropagation();
      if (terrainTool.lockedTerrains.has(desc.index)) {
        terrainTool.lockedTerrains.delete(desc.index);
        btn.classList.remove('swatch-row--locked');
      } else {
        terrainTool.lockedTerrains.add(desc.index);
        btn.classList.add('swatch-row--locked');
      }
    });
    btn.appendChild(lockEl);

    if (!DEFAULT_TERRAIN_IDS.has(desc.id)) {
      btn.classList.add('swatch-row--custom');
      btn.title = `${desc.name} (right-click to edit)`;
      btn.addEventListener('contextmenu', e => { e.preventDefault(); openTerrainDialog(desc.index); });
    } else {
      btn.title = desc.name;
    }

    btn.addEventListener('click', () => {
      terrainTool.paintTerrain = desc.index;
      document.querySelectorAll('#terrain-type-group .swatch-row')
        .forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
    });
    return btn;
  }

  /** A labelled palette section: header row and swatch grid. */
  function buildPaletteSection(
    label: string,
    descriptors: TerrainDescriptor[],
    sectionOpts: { tip?: string } = {},
  ): HTMLElement {
    const section = document.createElement('div');
    section.className = 'pal-section';

    const head = document.createElement('div');
    head.className = 'pal-head';
    const heading = document.createElement('div');
    heading.className = 'pal-head-label';
    heading.textContent = label;
    head.appendChild(heading);
    if (sectionOpts.tip) head.appendChild(buildInfoTip(sectionOpts.tip));
    section.appendChild(head);

    const grid = document.createElement('div');
    grid.className = 'pal-grid';
    for (const desc of descriptors) grid.appendChild(buildSwatchRow(desc));

    section.appendChild(grid);
    return section;
  }

  function renderTerrainPalette(): void {
    const group = document.getElementById('terrain-type-group')!;
    group.innerHTML = '';

    group.appendChild(buildPaletteSection(
      'Solid',
      terrainDescriptors.filter(d => !d.liquidType),
      { tip: 'Alt+click samples the cell under the cursor. Click the lock on a swatch to keep it.' },
    ));
    group.appendChild(buildPaletteSection(
      'Liquid',
      terrainDescriptors.filter(d => d.liquidType),
    ));

    scatterTool.refreshTerrainFilter(terrainDescriptors);
    // Terrain colors drive the minimap's fills, and a palette edit never touches
    // the undo stack — this is the only signal that they changed.
    opts.minimapInvalidate();
  }

  // ---- Add Terrain dialog ----
  addTerrainCloseBtw.addEventListener('click', () => addTerrainDialog.close());
  addTerrainDialog.addEventListener('click', e => { if (e.target === addTerrainDialog) addTerrainDialog.close(); });

  addTerrainColor.addEventListener('input', () => { addTerrainColorLbl.textContent = addTerrainColor.value; });
  addTerrainImgBtn.addEventListener('click', () => addTerrainImgInput.click());
  addTerrainImgInput.addEventListener('change', () => {
    const file = addTerrainImgInput.files?.[0];
    if (!file) return;
    pendingTerrainImage = file;
    addTerrainImgSt.textContent = file.name;
    addTerrainImgInput.value = '';
  });

  addTerrainConfirm.addEventListener('click', async () => {
    const name      = addTerrainName.value.trim();
    if (!name) { alert('Please enter a terrain name.'); return; }
    const color      = parseInt(addTerrainColor.value.slice(1), 16);
    const roadCost   = parseFloat(addTerrainCost.value) || 1;
    const liquidType = addTerrainLiquid.value || undefined;

    if (editingTerrainIndex !== null) {
      // ---- Edit existing ----
      const idx = terrainDescriptors.findIndex(d => d.index === editingTerrainIndex);
      if (idx >= 0) {
        const existing = terrainDescriptors[idx];
        let texture = existing.texture;
        if (pendingTerrainImage) {
          const assetId = `terrain-img-${existing.index}`;
          const bmp = await createImageBitmap(pendingTerrainImage);
          terrainAssetRegistry.set(assetId, bmp);
          terrainAssetBlobs.set(assetId, pendingTerrainImage);
          texture = { type: 'image' as const, assetId };
        }
        const updated: TerrainDescriptor = { ...existing, name, color, roadCost, texture };
        if (liquidType) updated.liquidType = liquidType; else delete updated.liquidType;
        terrainDescriptors = [
          ...terrainDescriptors.slice(0, idx),
          updated,
          ...terrainDescriptors.slice(idx + 1),
        ];
      }
    } else {
      // ---- Add new ----
      const nextIndex = Math.max(...terrainDescriptors.map(d => d.index)) + 1;
      let assetId: string | undefined;
      if (pendingTerrainImage) {
        assetId = `terrain-img-${nextIndex}`;
        const bmp = await createImageBitmap(pendingTerrainImage);
        terrainAssetRegistry.set(assetId, bmp);
        terrainAssetBlobs.set(assetId, pendingTerrainImage);
      }
      terrainDescriptors = [...terrainDescriptors, {
        index: nextIndex,
        id:    `custom-${nextIndex}`,
        name,
        color,
        texture:  assetId ? { type: 'image' as const, assetId } : { type: 'procedural' as const },
        roadCost,
        ...(liquidType ? { liquidType } : {}),
      }];
    }

    const isEdit = editingTerrainIndex !== null;
    addTerrainConfirm.disabled    = true;
    addTerrainConfirm.textContent = isEdit ? 'Saving…' : 'Applying…';
    await scene.rebuildTerrainFromDescriptors(terrainDescriptors, terrainAssetRegistry);
    addTerrainConfirm.disabled    = false;
    addTerrainConfirm.textContent = isEdit ? 'Save Changes' : 'Add Terrain';

    renderTerrainPalette();
    addTerrainDialog.close();
    pendingTerrainImage = null;
    addTerrainImgSt.textContent = 'No image';
  });

  // ---- Liquid Types dialog ----
  const cssHex = (c: number | undefined, fallback: number): string =>
    `#${(c ?? fallback).toString(16).padStart(6, '0')}`;

  /** Rebuild the liquid options in the add-terrain dialog and the liquid manager. */
  function refreshLiquidOptions(): void {
    const terrainSel = addTerrainLiquid.value;
    addTerrainLiquid.innerHTML = '<option value="">&#8212; solid &#8212;</option>';
    for (const d of liquidDescriptors) {
      const opt = document.createElement('option');
      opt.value = d.id;
      opt.textContent = d.name;
      addTerrainLiquid.appendChild(opt);
    }
    addTerrainLiquid.value = liquidDescriptors.some(d => d.id === terrainSel) ? terrainSel : '';

    liquidSelect.innerHTML = '';
    for (const d of liquidDescriptors) {
      const opt = document.createElement('option');
      opt.value = d.id;
      opt.textContent = d.name;
      liquidSelect.appendChild(opt);
    }
    const newOpt = document.createElement('option');
    newOpt.value = '__new';
    newOpt.textContent = '+ New liquid…';
    liquidSelect.appendChild(newOpt);
  }

  function loadLiquidForm(id: string): void {
    const d = liquidDescriptors.find(l => l.id === id);
    liquidName.value        = d?.name ?? '';
    liquidShallow.value     = cssHex(d?.shallowColor, 0x527fb3);
    liquidDeep.value        = cssHex(d?.deepColor,    0x1e477a);
    liquidFoam.value        = cssHex(d?.foamColor,    0xeaf3ff);
    liquidOpacity.value     = String(d?.opacity          ?? 0.82);
    liquidFlow.value        = String(d?.flowSpeed        ?? 1);
    liquidWave.value        = String(d?.waveScale        ?? 1);
    liquidFoamInt.value     = String(d?.foamIntensity    ?? 1);
    liquidEmissive.value    = cssHex(d?.emissiveColor, 0xff5a00);
    liquidEmissiveStr.value = String(d?.emissiveStrength ?? 0);
    liquidShallowLbl.textContent = liquidShallow.value;
    liquidDeepLbl.textContent    = liquidDeep.value;
    liquidFoamLbl.textContent    = liquidFoam.value;
  }

  function liquidIdFromName(name: string): string {
    const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'liquid';
    if (!liquidDescriptors.some(d => d.id === base)) return base;
    let n = 2;
    while (liquidDescriptors.some(d => d.id === `${base}-${n}`)) n++;
    return `${base}-${n}`;
  }

  liquidCloseBtn.addEventListener('click', () => liquidDialog.close());
  liquidDialog.addEventListener('click', e => { if (e.target === liquidDialog) liquidDialog.close(); });
  liquidShallow.addEventListener('input', () => { liquidShallowLbl.textContent = liquidShallow.value; });
  liquidDeep.addEventListener('input',    () => { liquidDeepLbl.textContent    = liquidDeep.value; });
  liquidFoam.addEventListener('input',    () => { liquidFoamLbl.textContent    = liquidFoam.value; });
  liquidSelect.addEventListener('change', () => loadLiquidForm(liquidSelect.value));

  function openLiquidDialog(): void {
    refreshLiquidOptions();
    liquidSelect.value = liquidDescriptors[0]?.id ?? '__new';
    loadLiquidForm(liquidSelect.value);
    liquidDialog.showModal();
  }

  liquidApplyBtn.addEventListener('click', () => {
    const name = liquidName.value.trim();
    if (!name) { alert('Please enter a liquid name.'); return; }
    const isNew = liquidSelect.value === '__new';
    const id    = isNew ? liquidIdFromName(name) : liquidSelect.value;

    const emissiveStrength = parseFloat(liquidEmissiveStr.value) || 0;
    const descriptor: LiquidTypeDescriptor = {
      id,
      name,
      shallowColor:  parseInt(liquidShallow.value.slice(1), 16),
      deepColor:     parseInt(liquidDeep.value.slice(1), 16),
      foamColor:     parseInt(liquidFoam.value.slice(1), 16),
      opacity:       Math.min(1, Math.max(0, parseFloat(liquidOpacity.value) || 0.82)),
      flowSpeed:     Math.max(0, parseFloat(liquidFlow.value) || 1),
      waveScale:     Math.max(0.05, parseFloat(liquidWave.value) || 1),
      foamIntensity: Math.max(0, parseFloat(liquidFoamInt.value) || 0),
      ...(emissiveStrength > 0 ? {
        emissiveColor:    parseInt(liquidEmissive.value.slice(1), 16),
        emissiveStrength,
      } : {}),
    };

    const idx = liquidDescriptors.findIndex(d => d.id === id);
    liquidDescriptors = idx >= 0
      ? [...liquidDescriptors.slice(0, idx), descriptor, ...liquidDescriptors.slice(idx + 1)]
      : [...liquidDescriptors, descriptor];

    scene.setLiquidDescriptors(liquidDescriptors);
    refreshLiquidOptions();
    liquidSelect.value = id;
    liquidDialog.close();
  });

  // ---- Menu entry points ----
  (document.getElementById('add-terrain-menu-btn') as HTMLButtonElement)
    .addEventListener('click', () => openTerrainDialog(null));
  (document.getElementById('liquid-menu-btn') as HTMLButtonElement)
    .addEventListener('click', () => openLiquidDialog());

  // ---- First render ----
  renderTerrainPalette();
  refreshLiquidOptions();

  return {
    get terrains() { return terrainDescriptors; },
    get liquids() { return liquidDescriptors; },
    textureAssets: terrainAssetBlobs,
    async textureAssetsAsDataURLs() {
      const out: Record<string, string> = {};
      for (const [id, blob] of terrainAssetBlobs) {
        out[id] = await new Promise<string>((res, rej) => {
          const reader = new FileReader();
          reader.onload  = () => res(reader.result as string);
          reader.onerror = () => rej(reader.error);
          reader.readAsDataURL(blob);
        });
      }
      return out;
    },
    openTerrainDialog,
    openLiquidDialog,
    async applyLoadedDescriptors(terrains, liquids, images) {
      terrainDescriptors = terrains.length > 0 ? terrains : [...EDITOR_DEFAULT_TERRAINS];
      terrainAssetBlobs.clear();
      terrainAssetRegistry.clear();
      if (images) {
        for (const [assetId, dataUrl] of Object.entries(images)) {
          try {
            const blob = await (await fetch(dataUrl)).blob();
            terrainAssetRegistry.set(assetId, await createImageBitmap(blob));
            terrainAssetBlobs.set(assetId, blob);
          } catch {
            // A corrupt image entry falls back to that terrain's procedural look.
          }
        }
      }
      await scene.rebuildTerrainFromDescriptors(terrainDescriptors, terrainAssetRegistry);
      liquidDescriptors = liquids.length > 0 ? liquids : structuredClone(DEFAULT_LIQUID_DESCRIPTORS);
      scene.setLiquidDescriptors(liquidDescriptors);
      renderTerrainPalette();
      refreshLiquidOptions();
    },
    adoptPackDescriptors(terrains, liquids) {
      terrainDescriptors = terrains;
      liquidDescriptors  = liquids.length > 0 ? liquids : structuredClone(DEFAULT_LIQUID_DESCRIPTORS);
      terrainAssetBlobs.clear();
      terrainAssetRegistry.clear();
      renderTerrainPalette();
      refreshLiquidOptions();
    },
  };
}
