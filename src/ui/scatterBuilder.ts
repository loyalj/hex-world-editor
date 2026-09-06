import { renderScatterThumbnail, resolveScatterAssets } from '@loyalj/hex-world';
import type {
  ScatterAssetDescriptor, ScatterDescriptor, ScatterRecipePart, ScatterPrimitive, ScatterPartRole,
  ScatterMaterialDescriptor, ScatterThresholds, TerrainDescriptor, WindSwayOptions,
} from '@loyalj/hex-world';
import { SCATTER_TEMPLATES, fromTemplate, tiersFor, refreshLayerNames, defaultScatter } from '../scatterRoster.ts';
import type { SceneApi } from '../scene.ts';

export interface ScatterBuilderOptions {
  scene: SceneApi;
  /** Live terrain palette, for the allowed-terrain chips. */
  terrains(): TerrainDescriptor[];
  /** The roster changed — brushes, rules text, and the document's dirty flag follow. */
  onChanged?(): void;
}

export interface ScatterBuilderApi {
  /** The current asset descriptors — what a save file records. */
  readonly assets: ScatterAssetDescriptor[];
  /** The current scatter descriptors — what a save file records. */
  readonly descriptors: ScatterDescriptor[];
  open(): void;
  /**
   * Adopt a set from a loaded save or pack. A file with descriptors but no
   * asset descriptors (an older save, or a pack of bare GLBs) keeps the
   * current set: there is nothing to build its shapes from. Both empty falls
   * back to the editor defaults.
   */
  applyLoaded(assets: ScatterAssetDescriptor[], descriptors: ScatterDescriptor[]): void;
}

const PRIMITIVES: ScatterPrimitive[] = ['cone', 'sphere', 'lobe', 'box', 'cylinder', 'segment', 'frond', 'rock'];
const ROLES: ScatterPartRole[] = ['canopy', 'trunk', 'body'];

/** Density curves the builder offers by name — the shared default and two scalings of it. */
const CURVES: Record<string, ScatterThresholds | undefined> = {
  default: undefined,
  thin:  [[0.0, 0.0, 0.2], [0.0, 0.2, 0.3], [0.2, 0.3, 0.4]],
  thick: [[0.0, 0.0, 0.6], [0.0, 0.6, 0.85], [0.6, 0.85, 1.0]],
};

const cssHex = (c: number): string => `#${c.toString(16).padStart(6, '0')}`;
const hexNum = (v: string): number => parseInt(v.slice(1), 16);

function slugId(name: string, taken: (id: string) => boolean): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'scatter';
  if (!taken(base)) return base;
  let n = 2;
  while (taken(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

function num(id: string): HTMLInputElement { return document.getElementById(id) as HTMLInputElement; }
function sel(id: string): HTMLSelectElement { return document.getElementById(id) as HTMLSelectElement; }
function chk(id: string): HTMLInputElement { return document.getElementById(id) as HTMLInputElement; }

/**
 * The Scatter Builder: a dialog that composes scatter types from primitive
 * parts, sets their sizes per density tier, their placement rules, and their
 * material behaviour, with a live thumbnail and a live map — every change is
 * pushed to the scene after a short debounce, so the plant is seen on real
 * terrain under the real light, not guessed at from a swatch.
 *
 * The roster it edits is what the scene draws and what persistence saves.
 * Edits sit outside the undo history like palette and environment changes.
 */
export function initScatterBuilder(opts: ScatterBuilderOptions): ScatterBuilderApi {
  const { scene } = opts;
  let { assets, descriptors } = defaultScatter();
  let selectedId: string | null = descriptors[0]?.id ?? null;

  const dialog   = document.getElementById('scatter-dialog') as HTMLDialogElement;
  const list     = document.getElementById('scatter-list')!;
  const preview  = document.getElementById('scatter-preview') as HTMLCanvasElement;
  const partsEl  = document.getElementById('scatter-parts')!;
  const editEl   = document.getElementById('scatter-edit')!;
  const template = sel('scatter-template');
  const layerSel = sel('scatter-layer');

  for (const t of SCATTER_TEMPLATES) {
    const o = document.createElement('option');
    o.value = t.id; o.textContent = t.name;
    template.appendChild(o);
  }

  // ---- roster → scene ----

  let pushTimer: number | null = null;
  function pushNow(): void {
    pushTimer = null;
    scene.setScatter(assets, descriptors);
    refreshLayerNames(descriptors);
    opts.onChanged?.();
  }
  function schedulePush(): void {
    if (pushTimer !== null) clearTimeout(pushTimer);
    pushTimer = window.setTimeout(pushNow, 220);
  }

  // ---- selection helpers ----

  const current = (): { desc: ScatterDescriptor; asset: ScatterAssetDescriptor } | null => {
    const desc = descriptors.find(d => d.id === selectedId);
    if (!desc) return null;
    const asset = assets.find(a => a.id === desc.tiers[0]?.[0]?.assetId);
    return asset ? { desc, asset } : null;
  };

  function renderList(): void {
    list.innerHTML = '';
    for (const d of descriptors) {
      const btn = document.createElement('button');
      btn.textContent = `${d.name}  ·  layer ${d.layerIndex}`;
      btn.classList.toggle('active', d.id === selectedId);
      btn.addEventListener('click', () => { selectedId = d.id; renderList(); loadForm(); });
      list.appendChild(btn);
    }
  }

  function renderPreview(): void {
    const cur = current();
    // No 2D context under a DOM without canvases (tests): the preview is
    // the one part of the builder that needs a GPU, so it is the one part
    // allowed to be absent.
    const ctx2d = preview.getContext('2d');
    if (!ctx2d) return;
    ctx2d.clearRect(0, 0, preview.width, preview.height);
    if (!cur || cur.asset.type !== 'shape') return;
    try {
      const registry = resolveScatterAssets([cur.asset]);
      const asset = registry.get(cur.asset.id)!;
      const thumb = renderScatterThumbnail(asset, { size: preview.width, angle: 35, elevation: 18 });
      ctx2d.drawImage(thumb, 0, 0);
      asset.geometry.dispose();
      asset.material.dispose();
    } catch (e) {
      ctx2d.fillStyle = '#e06a5a';
      ctx2d.fillText(String(e), 6, 16);
    }
  }

  // ---- form: descriptor-level fields ----

  function renderLayerOptions(selected: number): void {
    layerSel.innerHTML = '';
    const count = scene.map.featureLayerCount;
    for (let i = 0; i < count; i++) {
      const o = document.createElement('option');
      const others = descriptors.filter(d => d.layerIndex === i && d.id !== selectedId).map(d => d.name);
      o.value = String(i);
      o.textContent = others.length ? `${i}  —  shared with ${others.join(', ')}` : `${i}`;
      layerSel.appendChild(o);
    }
    layerSel.value = String(Math.min(selected, count - 1));
  }

  function renderTerrainChips(allowed: number[] | undefined): void {
    const group = document.getElementById('scatter-terrains')!;
    group.innerHTML = '';
    const active = new Set(allowed ?? []);
    for (const t of opts.terrains()) {
      const btn = document.createElement('button');
      btn.className = 'terrain-filter-btn';
      btn.title = t.name;
      btn.style.background = cssHex(t.color);
      btn.classList.toggle('active', active.has(t.index));
      btn.addEventListener('click', () => {
        const cur = current(); if (!cur) return;
        const set = new Set(cur.desc.allowedTerrains ?? []);
        if (set.has(t.index)) set.delete(t.index); else set.add(t.index);
        cur.desc.allowedTerrains = set.size ? [...set] : undefined;
        btn.classList.toggle('active', set.has(t.index));
        schedulePush();
      });
      group.appendChild(btn);
    }
  }

  function loadForm(): void {
    const cur = current();
    editEl.classList.toggle('hidden', !cur);
    if (!cur) return;
    const { desc, asset } = cur;
    const mat = asset.material ?? (asset.material = {});
    num('scatter-name').value    = desc.name;
    renderLayerOptions(desc.layerIndex);
    num('scatter-height').value  = String(asset.recipe?.height ?? asset.height ?? 1);
    num('scatter-tilt').value    = String(desc.tiltStrength ?? 0);
    for (let i = 0; i < 3; i++) num(`scatter-scale-${i}`).value = String(desc.tiers[i]?.[0]?.scale ?? 1);
    num('scatter-yoffset').value = String(desc.tiers[0]?.[0]?.yOffset ?? 0);
    sel('scatter-curve').value   = Object.entries(CURVES).find(([, v]) => JSON.stringify(v) === JSON.stringify(desc.thresholds))?.[0] ?? 'default';
    renderTerrainChips(desc.allowedTerrains);
    num('scatter-elev-min').value = desc.placement?.minElevation?.toString() ?? '';
    num('scatter-elev-max').value = desc.placement?.maxElevation?.toString() ?? '';
    chk('scatter-shore').checked        = !!desc.placement?.shore;
    chk('scatter-avoid-rivers').checked = !!desc.placement?.avoidRivers;

    const wind = mat.windSway;
    chk('scatter-wind').checked = !!wind;
    num('scatter-wind-amp').value   = String((typeof wind === 'object' ? wind.amplitude : undefined) ?? 0.06);
    num('scatter-wind-stiff').value = String((typeof wind === 'object' ? wind.stiffness : undefined) ?? 2);
    const tint = mat.seasonalTint;
    chk('scatter-seasons').checked = !!tint;
    num('scatter-blossom').value = String((typeof tint === 'object' ? tint.blossomShare : undefined) ?? 0);
    chk('scatter-snow').checked    = mat.snow !== false;
    chk('scatter-rock').checked    = !!mat.rock;
    chk('scatter-double').checked  = !!mat.doubleSide;
    num('scatter-opacity').value   = String(mat.opacity ?? 1);
    num('scatter-texture').value   = String(mat.scatterTexture ?? 0);

    renderParts();
    renderPreview();
  }

  function readPlacement(): ScatterDescriptor['placement'] {
    const min = num('scatter-elev-min').value.trim();
    const max = num('scatter-elev-max').value.trim();
    const p = {
      ...(min !== '' ? { minElevation: parseInt(min, 10) } : {}),
      ...(max !== '' ? { maxElevation: parseInt(max, 10) } : {}),
      ...(chk('scatter-shore').checked ? { shore: true } : {}),
      ...(chk('scatter-avoid-rivers').checked ? { avoidRivers: true } : {}),
    };
    return Object.keys(p).length ? p : undefined;
  }

  /** Read every descriptor- and material-level control back into the roster. */
  function readForm(): void {
    const cur = current(); if (!cur) return;
    const { desc, asset } = cur;
    const mat = asset.material ?? (asset.material = {});
    desc.name = num('scatter-name').value.trim() || desc.name;
    asset.name = desc.name;
    desc.layerIndex = parseInt(layerSel.value, 10) || 0;
    const tilt = parseFloat(num('scatter-tilt').value);
    desc.tiltStrength = Number.isFinite(tilt) && tilt > 0 ? tilt : undefined;
    const height = parseFloat(num('scatter-height').value);
    if (asset.recipe && Number.isFinite(height) && height > 0) asset.recipe.height = height;
    else if (asset.type === 'model' && Number.isFinite(height) && height > 0) asset.height = height;
    const yOffset = parseFloat(num('scatter-yoffset').value) || 0;
    const scales = [0, 1, 2].map(i => {
      const v = parseFloat(num(`scatter-scale-${i}`).value);
      return Number.isFinite(v) && v > 0 ? v : 1;
    }) as [number, number, number];
    desc.tiers = tiersFor(asset.id, scales, yOffset);
    desc.thresholds = CURVES[sel('scatter-curve').value];
    desc.placement = readPlacement();

    const wind = chk('scatter-wind').checked;
    mat.windSway = wind
      ? { amplitude: parseFloat(num('scatter-wind-amp').value) || 0.06, stiffness: parseFloat(num('scatter-wind-stiff').value) || 2,
          height: asset.recipe?.height ?? asset.height ?? 1 } satisfies WindSwayOptions
      : undefined;
    const seasons = chk('scatter-seasons').checked;
    const blossom = parseFloat(num('scatter-blossom').value) || 0;
    const prevTint = typeof mat.seasonalTint === 'object' ? mat.seasonalTint : {};
    mat.seasonalTint = seasons ? { ...prevTint, blossomShare: blossom } : undefined;
    mat.snow       = chk('scatter-snow').checked ? undefined : false;
    mat.rock       = chk('scatter-rock').checked || undefined;
    mat.doubleSide = chk('scatter-double').checked || undefined;
    const opacity  = parseFloat(num('scatter-opacity').value);
    mat.opacity    = Number.isFinite(opacity) && opacity < 1 ? Math.max(0.05, opacity) : undefined;
    const tex      = parseFloat(num('scatter-texture').value);
    mat.scatterTexture = Number.isFinite(tex) && tex > 0 ? Math.min(1, tex) : undefined;
    // Drop undefined keys so the saved JSON stays tidy.
    for (const k of Object.keys(mat) as (keyof ScatterMaterialDescriptor)[]) if (mat[k] === undefined) delete mat[k];
    for (const k of ['tiltStrength', 'thresholds', 'placement', 'allowedTerrains'] as const) if (desc[k] === undefined) delete desc[k];
  }

  function onFormInput(): void {
    readForm();
    renderList();
    renderPreview();
    schedulePush();
  }
  for (const id of ['scatter-name', 'scatter-height', 'scatter-tilt', 'scatter-scale-0', 'scatter-scale-1', 'scatter-scale-2',
    'scatter-yoffset', 'scatter-elev-min', 'scatter-elev-max', 'scatter-wind-amp', 'scatter-wind-stiff', 'scatter-blossom',
    'scatter-opacity', 'scatter-texture']) {
    document.getElementById(id)!.addEventListener('input', onFormInput);
  }
  for (const id of ['scatter-layer', 'scatter-curve', 'scatter-shore', 'scatter-avoid-rivers', 'scatter-wind', 'scatter-seasons',
    'scatter-snow', 'scatter-rock', 'scatter-double']) {
    document.getElementById(id)!.addEventListener('change', onFormInput);
  }

  // ---- form: parts ----

  function partField(label: string, value: number, step: number, onInput: (v: number) => void, min?: number): HTMLElement {
    const wrap = document.createElement('label');
    wrap.className = 'scatter-part-field';
    const span = document.createElement('span'); span.textContent = label;
    const input = document.createElement('input');
    input.type = 'number'; input.step = String(step); input.value = String(value); input.autocomplete = 'off';
    if (min !== undefined) input.min = String(min);
    input.addEventListener('input', () => { const v = parseFloat(input.value); if (Number.isFinite(v)) { onInput(v); renderPreview(); schedulePush(); } });
    wrap.append(span, input);
    return wrap;
  }

  function partSelect<T extends string>(label: string, value: T, options: readonly T[], onChange: (v: T) => void): HTMLElement {
    const wrap = document.createElement('label');
    wrap.className = 'scatter-part-field';
    const span = document.createElement('span'); span.textContent = label;
    const s = document.createElement('select');
    for (const o of options) { const el = document.createElement('option'); el.value = o; el.textContent = o; s.appendChild(el); }
    s.value = value;
    s.addEventListener('change', () => { onChange(s.value as T); renderPreview(); schedulePush(); });
    wrap.append(span, s);
    return wrap;
  }

  function triple(part: ScatterRecipePart, key: 'size' | 'position' | 'rotation', label: string, step: number): HTMLElement {
    const row = document.createElement('div');
    row.className = 'scatter-part-triple';
    const get = (): [number, number, number] => {
      if (key === 'size') return typeof part.size === 'number' ? [part.size, part.size, part.size] : part.size;
      return part[key] ?? [0, 0, 0];
    };
    const set = (i: number, v: number): void => {
      const cur = [...get()] as [number, number, number];
      cur[i] = v;
      if (key === 'size') part.size = cur; else part[key] = cur;
    };
    const head = document.createElement('span'); head.textContent = label; head.className = 'scatter-part-triple-label';
    row.appendChild(head);
    ['x', 'y', 'z'].forEach((axis, i) => row.appendChild(partField(axis, get()[i], step, v => set(i, v))));
    return row;
  }

  function renderParts(): void {
    partsEl.innerHTML = '';
    const cur = current(); if (!cur) return;
    const recipe = cur.asset.recipe;
    if (!recipe) {
      const note = document.createElement('div');
      note.className = 'field-hint';
      note.textContent = 'A GLB model asset from a pack — its shape is the file. Height, tiers, placement, and behaviour still apply.';
      partsEl.appendChild(note);
      return;
    }
    recipe.parts.forEach((part, index) => {
      const box = document.createElement('div');
      box.className = 'scatter-part';

      const head = document.createElement('div');
      head.className = 'scatter-part-head';
      head.appendChild(partSelect('Shape', part.primitive, PRIMITIVES, v => { part.primitive = v; }));
      head.appendChild(partSelect('Role', part.role ?? 'body', ROLES, v => { part.role = v; }));
      const colorWrap = document.createElement('label');
      colorWrap.className = 'scatter-part-field';
      const cs = document.createElement('span'); cs.textContent = 'Colour';
      const color = document.createElement('input');
      color.type = 'color'; color.value = cssHex(part.color);
      color.addEventListener('input', () => { part.color = hexNum(color.value); renderPreview(); schedulePush(); });
      colorWrap.append(cs, color);
      head.appendChild(colorWrap);
      const tools = document.createElement('div');
      tools.className = 'scatter-part-tools';
      const mk = (text: string, title: string, fn: () => void, disabled = false): void => {
        const b = document.createElement('button'); b.textContent = text; b.title = title; b.disabled = disabled;
        b.addEventListener('click', () => { fn(); renderParts(); renderPreview(); schedulePush(); });
        tools.appendChild(b);
      };
      mk('↑', 'Move up',   () => { [recipe.parts[index - 1], recipe.parts[index]] = [recipe.parts[index], recipe.parts[index - 1]]; }, index === 0);
      mk('↓', 'Move down', () => { [recipe.parts[index + 1], recipe.parts[index]] = [recipe.parts[index], recipe.parts[index + 1]]; }, index === recipe.parts.length - 1);
      mk('⧉', 'Duplicate', () => { recipe.parts.splice(index + 1, 0, structuredClone(part)); });
      mk('✕', 'Remove',    () => { recipe.parts.splice(index, 1); }, recipe.parts.length === 1);
      head.appendChild(tools);
      box.appendChild(head);

      box.appendChild(triple(part, 'size', 'Size', 0.01));
      box.appendChild(triple(part, 'position', 'Offset', 0.01));
      box.appendChild(triple(part, 'rotation', 'Rotate°', 1));

      const extra = document.createElement('div');
      extra.className = 'scatter-part-triple';
      extra.appendChild(partField('Detail', part.detail ?? (part.primitive === 'sphere' || part.primitive === 'lobe' ? 0 : 7), 1, v => { part.detail = v; }, 0));
      extra.appendChild(partField('Bend°', part.bend ?? 0, 1, v => { part.bend = v || undefined; }));
      box.appendChild(extra);

      const rep = document.createElement('div');
      rep.className = 'scatter-part-triple';
      const r = part.repeat;
      const ensure = (): NonNullable<ScatterRecipePart['repeat']> => (part.repeat ??= { count: 1 });
      rep.appendChild(partField('Repeat', r?.count ?? 1, 1, v => { if (v <= 1) delete part.repeat; else ensure().count = Math.round(v); }, 1));
      rep.appendChild(partField('Radius', r?.radius ?? 0, 0.01, v => { ensure().radius = v; }));
      rep.appendChild(partField('Droop°', r?.droop ?? 0, 1, v => { ensure().droop = v; }));
      rep.appendChild(partField('Jitter', r?.jitter ?? 0, 0.05, v => { ensure().jitter = v; }, 0));
      box.appendChild(rep);

      partsEl.appendChild(box);
    });
  }

  document.getElementById('scatter-part-add')!.addEventListener('click', () => {
    const cur = current(); if (!cur?.asset.recipe) return;
    cur.asset.recipe.parts.push({ primitive: 'sphere', size: 0.3, position: [0, 0, 0], color: 0x6f9c3a, role: 'canopy' });
    renderParts(); renderPreview(); schedulePush();
  });

  // ---- list actions ----

  function freeLayer(): number {
    const used = new Set(descriptors.map(d => d.layerIndex));
    for (let i = 0; i < scene.map.featureLayerCount; i++) if (!used.has(i)) return i;
    return Math.max(0, scene.map.featureLayerCount - 1);
  }

  document.getElementById('scatter-add-btn')!.addEventListener('click', () => {
    const t = SCATTER_TEMPLATES.find(x => x.id === template.value) ?? SCATTER_TEMPLATES[0];
    const taken = (id: string): boolean => descriptors.some(d => d.id === id) || assets.some(a => a.id === `${id}-shape`);
    const id = slugId(t.name, taken);
    const { asset, descriptor } = fromTemplate(t, id, t.name, freeLayer());
    assets.push(asset); descriptors.push(descriptor);
    selectedId = id;
    renderList(); loadForm(); schedulePush();
  });

  document.getElementById('scatter-dup-btn')!.addEventListener('click', () => {
    const cur = current(); if (!cur) return;
    const taken = (id: string): boolean => descriptors.some(d => d.id === id) || assets.some(a => a.id === `${id}-shape`);
    const id = slugId(`${cur.desc.name} copy`, taken);
    const asset: ScatterAssetDescriptor = { ...structuredClone(cur.asset), id: `${id}-shape`, name: `${cur.desc.name} copy` };
    const desc: ScatterDescriptor = { ...structuredClone(cur.desc), id, name: asset.name!,
      tiers: cur.desc.tiers.map(tier => tier.map(v => ({ ...v, assetId: asset.id }))) };
    assets.push(asset); descriptors.push(desc);
    selectedId = id;
    renderList(); loadForm(); schedulePush();
  });

  document.getElementById('scatter-del-btn')!.addEventListener('click', () => {
    const cur = current(); if (!cur) return;
    if (!confirm(`Delete "${cur.desc.name}"? Painted density on its layer stays on the map.`)) return;
    descriptors = descriptors.filter(d => d.id !== cur.desc.id);
    const stillUsed = descriptors.some(d => d.tiers.flat().some(v => v.assetId === cur.asset.id));
    if (!stillUsed) assets = assets.filter(a => a.id !== cur.asset.id);
    selectedId = descriptors[0]?.id ?? null;
    renderList(); loadForm(); schedulePush();
  });

  document.getElementById('scatter-close-btn')!.addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', e => { if (e.target === dialog) dialog.close(); });
  dialog.addEventListener('close', () => { if (pushTimer !== null) { clearTimeout(pushTimer); pushNow(); } });

  function open(): void {
    if (!descriptors.some(d => d.id === selectedId)) selectedId = descriptors[0]?.id ?? null;
    renderList();
    loadForm();
    if (typeof dialog.showModal === 'function') dialog.showModal();
  }

  function applyLoaded(loadedAssets: ScatterAssetDescriptor[], loadedDescriptors: ScatterDescriptor[]): void {
    if (loadedDescriptors.length > 0 && loadedAssets.length > 0) {
      assets = structuredClone(loadedAssets);
      descriptors = structuredClone(loadedDescriptors);
    } else if (loadedDescriptors.length === 0) {
      ({ assets, descriptors } = defaultScatter());
    }
    selectedId = descriptors[0]?.id ?? null;
    pushNow();
  }

  // The scene opens with the default set built the same way, so the first
  // push is deferred to the first edit; the layer names still need seeding.
  refreshLayerNames(descriptors);

  return {
    get assets() { return assets; },
    get descriptors() { return descriptors; },
    open,
    applyLoaded,
  };
}
