import { HexMap, generatePluginAsync, drawMapImage, getMapImageTransform } from '@loyalj/hex-world';
import type { HexLayout, TerrainDefinition, MapGeneratorPlugin } from '@loyalj/hex-world';
import { renderConfigFields } from './configUI.ts';
import type { ConfigObj, ConfigFieldEx } from './configUI.ts';
import {
  WORLD_SHAPES, WIZARD_CLIMATES, SIZE_PRESETS,
  getShape, getClimate, defaultAnswers, resolveSize,
  compileWizard, applyScatterDensity, computeMapStats,
} from './wizardConfig.ts';
import type { WizardAnswers, CompiledWizard } from './wizardConfig.ts';

/** How long a settings change waits for further changes before regenerating. */
const PREVIEW_DEBOUNCE_MS = 250;
/** Generated full-size maps kept around, newest last. ~0.5MB each at 256². */
const GEN_CACHE_MAX = 12;

const RUGGEDNESS_LABELS = ['flat plains', 'gentle', 'rolling hills', 'hilly', 'jagged'];
const MOUNTAIN_LABELS   = ['subtle', 'low', 'moderate', 'high', 'towering'];
const COAST_LABELS      = ['smooth', 'wavy', 'ragged', 'fractal'];

const STEP_TITLES = ['World shape', 'Climate', 'Terrain detail', 'Size & features'];

export interface WizardCreateResult {
  map:      HexMap;
  pluginId: string;
  seed:     number;
}

/**
 * What the wizard needs from a generator plugin. Structurally the library's
 * MapGeneratorPlugin, except the config schema may carry the editor's extra
 * field types (the heightmap image picker).
 */
export interface WizardPlugin {
  readonly id:            string;
  readonly name:          string;
  readonly defaultConfig: unknown;
  readonly configSchema?: ConfigFieldEx[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  generate(map: HexMap, config: any, seed: number): void;
}

export interface WizardOptions {
  dialog:            HTMLDialogElement;
  layout:            HexLayout;
  /** Live getter — the editor's terrain palette can change between opens. */
  terrainDefinitions: () => TerrainDefinition[];
  plugins:           WizardPlugin[];
  featureLayerCount: number;
  initialSeed:       number;
  onCreate:          (result: WizardCreateResult) => void;
}

export interface WizardApi {
  open(): void;
}

export function initWizard(opts: WizardOptions): WizardApi {
  const { dialog, layout, plugins } = opts;

  // ---- State ----
  const answers: WizardAnswers = defaultAnswers(opts.initialSeed);
  let step = 0;
  let view: 'wizard' | 'params' = 'wizard';
  /** True once the raw config was hand-edited — raw values win until a wizard control is touched. */
  let custom = false;
  let params: CompiledWizard = compileWizard(answers);
  let busy = false;
  /** Bumped on every hand-edit of the raw config — the cache key for custom plans. */
  let paramsRev = 0;
  let previewTimer: number | null = null;

  // ---- Single source of truth for generated maps ----
  //
  // Every view — shape card, preview panel, Create — resolves through this
  // cache at the map's REAL dimensions, so they are all literally the same
  // map. A low-res approximation is a different map (the generators lay work
  // out by cell), and showing one next to the real thing broke trust in the
  // whole wizard.
  const genCache = new Map<string, { map?: HexMap; promise: Promise<HexMap> }>();

  function planKey(plan: CompiledWizard, seed: number): string {
    // Custom raw configs can hold non-JSON payloads (heightmap pixels), so
    // they key on an edit revision instead of their contents.
    const cfg = custom && plan === params
      ? `custom#${paramsRev}`
      : JSON.stringify(plan.config);
    return `${plan.pluginId}|${plan.width}x${plan.height}|${seed}|${cfg}`;
  }

  function getMapAsync(
    plan: CompiledWizard,
    seed: number,
    onProgress?: (fraction: number) => void,
  ): Promise<HexMap> {
    const key = planKey(plan, seed);
    const hit = genCache.get(key);
    if (hit) {
      if (hit.map) onProgress?.(1);
      return hit.promise;
    }
    const plugin = plugins.find(p => p.id === plan.pluginId);
    if (!plugin) return Promise.reject(new Error(`Unknown generator '${plan.pluginId}'`));

    const map = new HexMap({
      width: plan.width, height: plan.height,
      featureLayerCount: opts.featureLayerCount,
    });
    // The volcano pass wants terrain indices the schema cannot know: whichever
    // lava and ash the palette carries right now, found by id so a re-indexed
    // palette still lines up. Without them a volcano is a dry rock crater.
    const defs   = opts.terrainDefinitions();
    const lava   = defs.find(d => d.id === 'lava')?.index;
    const ash    = defs.find(d => d.id === 'ash')?.index;
    const config = {
      ...(plan.config as Record<string, unknown>),
      ...(lava !== undefined ? { volcanoLavaTerrain: lava } : {}),
      ...(ash  !== undefined ? { volcanoAshTerrain:  ash  } : {}),
    };
    const entry = {
      map: undefined as HexMap | undefined,
      promise: generatePluginAsync(
        plugin as unknown as MapGeneratorPlugin<unknown>, map, config, seed,
        // 40ms slices: a full 100² map is only ~400ms of work, and every
        // yield hands the 3D scene a frame — pay that tax sparingly.
        { sliceMs: 40, onProgress: p => onProgress?.(p.progress) },
      ).then(() => {
        entry.map = map;
        return map;
      }).catch(err => {
        genCache.delete(key); // don't cache failures
        throw err;
      }),
    };
    genCache.set(key, entry);
    while (genCache.size > GEN_CACHE_MAX) {
      const oldest = genCache.keys().next().value!;
      genCache.delete(oldest);
    }
    return entry.promise;
  }

  /** Hand a cached map over for keeps (the scene will mutate it). */
  function takeMap(plan: CompiledWizard, seed: number): void {
    genCache.delete(planKey(plan, seed));
  }

  /** The plan every view renders: raw params when hand-edited, else the wizard compile. */
  function currentPlan(): CompiledWizard {
    return custom ? params : compileWizard(answers);
  }

  // ---- Skeleton ----
  dialog.innerHTML = `
    <div class="dialog-header">
      <span class="dialog-title">New map</span>
      <span id="wiz-custom-badge" class="wiz-badge hidden">Custom</span>
      <button class="dialog-close" id="wiz-close-btn">&#x2715;</button>
    </div>
    <div class="wiz-stepper" id="wiz-stepper"></div>
    <div class="wiz-main">
      <div class="wiz-content" id="wiz-content"></div>
      <aside class="wiz-preview">
        <div class="wiz-preview-head">Preview <span id="wiz-preview-progress"></span></div>
        <div class="wiz-preview-frame"><canvas id="wiz-preview-canvas"></canvas></div>
        <div class="wiz-stats" id="wiz-stats"></div>
        <div class="wiz-note">This is the actual map — Create hands you exactly what you see here.</div>
      </aside>
    </div>
    <div class="wiz-footer">
      <div class="wiz-seed-pill">
        <span>Seed</span>
        <b id="wiz-seed-value"></b>
        <button id="wiz-reroll-btn" type="button">Reroll</button>
      </div>
      <span class="wiz-seed-hint">Same shape, different world.</span>
      <div class="wiz-footer-actions">
        <button class="wiz-btn wiz-btn-ghost"  id="wiz-cancel-btn"  type="button">Cancel</button>
        <button class="wiz-btn wiz-btn-ghost"  id="wiz-params-btn"  type="button">All parameters</button>
        <button class="wiz-btn"                id="wiz-back-btn"    type="button">&#8592; Back</button>
        <button class="wiz-btn"                id="wiz-create-now-btn" type="button">Create now</button>
        <button class="wiz-btn wiz-btn-primary" id="wiz-next-btn"   type="button"></button>
      </div>
    </div>
  `;

  const q = <T extends HTMLElement>(id: string): T => dialog.querySelector(`#${id}`) as T;
  const stepperEl     = q<HTMLDivElement>('wiz-stepper');
  const contentEl     = q<HTMLDivElement>('wiz-content');
  const statsEl       = q<HTMLDivElement>('wiz-stats');
  const previewCanvas = q<HTMLCanvasElement>('wiz-preview-canvas');
  const previewProgress = q<HTMLSpanElement>('wiz-preview-progress');
  const customBadge   = q<HTMLSpanElement>('wiz-custom-badge');
  const seedValueEl   = q<HTMLElement>('wiz-seed-value');
  const closeBtn      = q<HTMLButtonElement>('wiz-close-btn');
  const cancelBtn     = q<HTMLButtonElement>('wiz-cancel-btn');
  const paramsBtn     = q<HTMLButtonElement>('wiz-params-btn');
  const backBtn       = q<HTMLButtonElement>('wiz-back-btn');
  const createNowBtn  = q<HTMLButtonElement>('wiz-create-now-btn');
  const nextBtn       = q<HTMLButtonElement>('wiz-next-btn');

  // ---- Small DOM helpers ----

  function el(tag: string, className?: string, text?: string): HTMLElement {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function segmented(
    options: { value: string; label: string; sub?: string }[],
    active: string,
    onPick: (value: string) => void,
  ): HTMLElement {
    const wrap = el('div', 'segmented');
    for (const opt of options) {
      const btn = el('button', opt.value === active ? 'active' : '', opt.label) as HTMLButtonElement;
      btn.type = 'button';
      if (opt.sub) btn.appendChild(el('span', 'wiz-seg-sub', opt.sub));
      btn.addEventListener('click', () => {
        for (const b of wrap.children) b.classList.toggle('active', b === btn);
        onPick(opt.value);
      });
      wrap.appendChild(btn);
    }
    return wrap;
  }

  function sliderRow(
    label: string,
    value: number,
    describe: (v: number) => string,
    onInput: (v: number) => void,
  ): HTMLElement {
    const wrap  = el('div', 'wiz-slider');
    const head  = el('div', 'wiz-slider-head');
    const title = el('span', 'wiz-slider-label', label);
    const desc  = el('span', 'wiz-slider-value', describe(value));
    head.appendChild(title);
    head.appendChild(desc);

    const input = document.createElement('input');
    input.type = 'range';
    input.min = '0'; input.max = '100';
    input.value = String(Math.round(value * 100));
    input.addEventListener('input', () => {
      const v = parseInt(input.value, 10) / 100;
      desc.textContent = describe(v);
      onInput(v);
    });

    wrap.appendChild(head);
    wrap.appendChild(input);
    return wrap;
  }

  /** A wizard control was touched — raw-config edits no longer win. */
  function touchWizard(): void {
    if (custom) {
      custom = false;
      customBadge.classList.add('hidden');
    }
    schedulePreview();
  }

  // ---- Thumbnails ----

  /**
   * The plan a shape's card must show: for the selected shape, exactly the
   * plan the preview and Create use; for the others, exactly the plan that
   * clicking the card would switch to (its click assigns the shape defaults).
   * Same plan → same cache key → literally the same map in every view.
   */
  function shapePlan(shapeId: string): CompiledWizard {
    if (shapeId === answers.shapeId) return currentPlan();
    const shape = getShape(shapeId);
    return compileWizard({ ...answers, shapeId, ...shape.defaults });
  }

  // Card maps generate one at a time (each is already sliced internally), so
  // five full-size generations don't fight each other for the main thread.
  let thumbChain: Promise<void> = Promise.resolve();

  function queueThumb(plan: CompiledWizard, canvas: HTMLCanvasElement): void {
    const seed = answers.seed;
    thumbChain = thumbChain.then(async () => {
      try {
        const map = await getMapAsync(plan, seed);
        if (!canvas.isConnected) return; // card re-rendered away meanwhile
        drawInto(canvas, map, 208);
      } catch { /* card stays as its pending placeholder */ }
      canvas.classList.remove('wiz-thumb-pending');
    });
  }

  function drawInto(canvas: HTMLCanvasElement, map: HexMap, targetWidth: number): void {
    const base  = getMapImageTransform(map, layout, { scale: 1, padding: 0 });
    const scale = targetWidth / base.width;
    canvas.width  = Math.ceil(base.width  * scale);
    canvas.height = Math.ceil(base.height * scale);
    drawMapImage(canvas.getContext('2d')!, map, layout, opts.terrainDefinitions(), {
      scale, padding: 0,
      background: '#131316',
      elevationShading: 0.04,
      rivers: true,
      roads:  true,
    });
  }

  // ---- Preview panel ----

  function schedulePreview(): void {
    if (previewTimer !== null) window.clearTimeout(previewTimer);
    previewTimer = window.setTimeout(() => {
      previewTimer = null;
      renderPreview();
    }, PREVIEW_DEBOUNCE_MS);
  }

  let previewToken = 0;

  function setPreviewProgress(fraction: number | null): void {
    previewProgress.textContent = fraction === null ? '' : `${Math.round(fraction * 100)}%`;
  }

  async function renderPreview(): Promise<void> {
    const token = ++previewToken;
    const plan = currentPlan();
    if (plan.pluginId === 'heightmap' && !(plan.config as { image?: unknown }).image) {
      setPreviewProgress(null);
      renderStats([['Preview', 'needs an image']]);
      return;
    }
    setPreviewProgress(0);
    try {
      const map = await getMapAsync(plan, answers.seed, f => {
        if (token === previewToken) setPreviewProgress(f);
      });
      if (token !== previewToken) return; // superseded while generating
      setPreviewProgress(null);
      drawInto(previewCanvas, map, 232);

      const stats = computeMapStats(map);
      renderStats([
        ['Land',          `${stats.landPct}%`],
        ['Water',         `${stats.waterPct}%`],
        ['Highest point', `+${stats.highest}`],
        ['Coastline',     `${stats.coastline} cells`],
      ]);
    } catch {
      if (token !== previewToken) return;
      setPreviewProgress(null);
      renderStats([['Preview', 'unavailable']]);
    }
  }

  function renderStats(rows: [string, string][]): void {
    statsEl.innerHTML = '';
    for (const [label, value] of rows) {
      const row = el('div', 'wiz-stat-row');
      row.appendChild(el('span', '', label));
      row.appendChild(el('b', '', value));
      statsEl.appendChild(row);
    }
  }

  // ---- Stepper ----

  function stepSubtitle(i: number): string {
    switch (i) {
      case 0: return getShape(answers.shapeId).name;
      case 1: return getClimate(answers.climateId).name;
      case 2: return RUGGEDNESS_LABELS[Math.round(answers.ruggedness * (RUGGEDNESS_LABELS.length - 1))];
      default: {
        const size = resolveSize(answers);
        return `${size.width} × ${size.height}`;
      }
    }
  }

  function renderStepper(): void {
    stepperEl.innerHTML = '';
    STEP_TITLES.forEach((title, i) => {
      if (i > 0) stepperEl.appendChild(el('div', 'wiz-stepper-line'));
      const node = el('button', 'wiz-step' + (i === step && view === 'wizard' ? ' active' : '')) as HTMLButtonElement;
      node.type = 'button';
      node.appendChild(el('div', 'wiz-step-dot', String(i + 1)));
      const text = el('div', 'wiz-step-text');
      text.appendChild(el('div', 'wiz-step-title', title));
      text.appendChild(el('div', 'wiz-step-sub', stepSubtitle(i)));
      node.appendChild(text);
      node.addEventListener('click', () => { if (!busy) goToStep(i); });
      stepperEl.appendChild(node);
    });
  }

  function goToStep(i: number): void {
    step = i;
    view = 'wizard';
    render();
  }

  // ---- Step panels ----

  function stepHeading(title: string, blurb: string): HTMLElement {
    const wrap = el('div', 'wiz-heading');
    wrap.appendChild(el('h3', '', title));
    wrap.appendChild(el('p', '', blurb));
    return wrap;
  }

  function renderShapeStep(): void {
    contentEl.appendChild(stepHeading(
      'What kind of world is this?',
      'Pick the big shape. Everything after this only nudges it — you can come back at any step.',
    ));
    const grid = el('div', 'wiz-card-grid');
    const pending: { shapeId: string; canvas: HTMLCanvasElement }[] = [];
    for (const shape of WORLD_SHAPES) {
      const card = el('button', 'wiz-card' + (shape.id === answers.shapeId ? ' active' : '')) as HTMLButtonElement;
      card.type = 'button';
      const canvas = document.createElement('canvas');
      canvas.className = 'wiz-thumb wiz-thumb-pending';
      card.appendChild(canvas);
      pending.push({ shapeId: shape.id, canvas });
      const body = el('div', 'wiz-card-body');
      body.appendChild(el('div', 'wiz-card-title', shape.name));
      body.appendChild(el('div', 'wiz-card-blurb', shape.blurb));
      card.appendChild(body);
      card.addEventListener('click', () => {
        answers.shapeId = shape.id;
        Object.assign(answers, shape.defaults);
        touchWizard();
        render();
      });
      grid.appendChild(card);
    }
    contentEl.appendChild(grid);
    // Selected shape first: its map is also the preview's and Create's.
    pending.sort((a, b) => Number(b.shapeId === answers.shapeId) - Number(a.shapeId === answers.shapeId));
    for (const p of pending) queueThumb(shapePlan(p.shapeId), p.canvas);
  }

  function renderClimateStep(): void {
    contentEl.appendChild(stepHeading(
      'How does it feel to live there?',
      'Sets which terrain types the generator reaches for.',
    ));
    const grid = el('div', 'wiz-climate-grid');
    for (const climate of WIZARD_CLIMATES) {
      const card = el('button', 'wiz-climate' + (climate.id === answers.climateId ? ' active' : '')) as HTMLButtonElement;
      card.type = 'button';
      card.appendChild(el('div', 'wiz-climate-name', climate.name));
      const strip = el('div', 'wiz-swatch-strip');
      for (const color of climate.swatches) {
        const sw = el('div', 'wiz-swatch');
        sw.style.background = color;
        strip.appendChild(sw);
      }
      card.appendChild(strip);
      card.addEventListener('click', () => {
        answers.climateId = climate.id;
        touchWizard();
        render();
      });
      grid.appendChild(card);
    }
    contentEl.appendChild(grid);

    if (getShape(answers.shapeId).supports.seaLevel) {
      contentEl.appendChild(sliderRow(
        'Sea level', answers.seaLevel,
        v => `${Math.round(v * 100)}% water`,
        v => { answers.seaLevel = v; touchWizard(); },
      ));
      const scale = el('div', 'wiz-slider-scale');
      scale.appendChild(el('span', '', 'No sea'));
      scale.appendChild(el('span', '', 'Drowned'));
      contentEl.appendChild(scale);
    }
  }

  function renderDetailStep(): void {
    const supports = getShape(answers.shapeId).supports;
    contentEl.appendChild(stepHeading(
      'Now the details',
      'Plain-language dials. The raw generator numbers live under All parameters.',
    ));
    const pickLabel = (labels: string[]) => (v: number) => labels[Math.round(v * (labels.length - 1))];

    contentEl.appendChild(sliderRow('Ruggedness', answers.ruggedness,
      pickLabel(RUGGEDNESS_LABELS), v => { answers.ruggedness = v; touchWizard(); }));
    contentEl.appendChild(sliderRow('Mountain height', answers.mountainHeight,
      pickLabel(MOUNTAIN_LABELS), v => { answers.mountainHeight = v; touchWizard(); }));
    if (supports.coastDetail) {
      contentEl.appendChild(sliderRow('Coastline detail', answers.coastDetail,
        pickLabel(COAST_LABELS), v => { answers.coastDetail = v; touchWizard(); }));
    }
    if (supports.erosion) {
      contentEl.appendChild(sliderRow('Erosion', answers.erosion,
        v => `${Math.round(v * 100)}% · softens ridges`,
        v => { answers.erosion = v; touchWizard(); }));
    }
  }

  function renderSizeStep(): void {
    const supports = getShape(answers.shapeId).supports;
    contentEl.appendChild(stepHeading(
      "How big, and what's on it?",
      'Rivers, roads and scatter are generated once, then fully editable.',
    ));

    const sizeField = el('div', 'wiz-field');
    sizeField.appendChild(el('div', 'wiz-field-label', 'Size'));
    sizeField.appendChild(segmented(
      [
        { value: 'small',  label: 'Small',  sub: `${SIZE_PRESETS.small.width}²`  },
        { value: 'medium', label: 'Medium', sub: `${SIZE_PRESETS.medium.width}²` },
        { value: 'large',  label: 'Large',  sub: `${SIZE_PRESETS.large.width}²`  },
        { value: 'custom', label: 'Custom', sub: '—' },
      ],
      answers.sizeId,
      v => {
        answers.sizeId = v as WizardAnswers['sizeId'];
        touchWizard();
        render();
      },
    ));
    contentEl.appendChild(sizeField);

    if (answers.sizeId === 'custom') {
      const row = el('div', 'wiz-custom-size');
      for (const dim of ['width', 'height'] as const) {
        const label = el('label', 'wiz-dim');
        label.appendChild(el('span', '', dim === 'width' ? 'Width' : 'Height'));
        const input = document.createElement('input');
        input.type = 'number';
        input.min = '10'; input.max = '512';
        input.value = String(dim === 'width' ? answers.customWidth : answers.customHeight);
        input.addEventListener('change', () => {
          const v = parseInt(input.value, 10) || 100;
          if (dim === 'width') answers.customWidth = v; else answers.customHeight = v;
          touchWizard();
          renderStepper();
        });
        label.appendChild(input);
        row.appendChild(label);
      }
      contentEl.appendChild(row);
    }

    const features = el('div', 'wiz-field');
    features.appendChild(el('div', 'wiz-field-label', 'Features'));

    features.appendChild(featureRow('Rivers', answers.rivers !== 'none', on => {
      answers.rivers = on ? 'some' : 'none';
      touchWizard();
      render();
    }, answers.rivers === 'none' ? null : segmented(
      [{ value: 'few', label: 'Few' }, { value: 'some', label: 'Some' }, { value: 'many', label: 'Many' }],
      answers.rivers,
      v => { answers.rivers = v as WizardAnswers['rivers']; touchWizard(); },
    )));

    features.appendChild(featureRow('Roads between regions', answers.roads, on => {
      answers.roads = on;
      touchWizard();
      render();
    }, supports.regions && answers.roads ? regionChip() : null));

    features.appendChild(featureRow('Trees & rocks', answers.scatter !== 'none', on => {
      answers.scatter = on ? 'medium' : 'none';
      touchWizard();
      render();
    }, answers.scatter === 'none' ? null : segmented(
      [{ value: 'sparse', label: 'Sparse' }, { value: 'medium', label: 'Medium' }, { value: 'dense', label: 'Dense' }],
      answers.scatter,
      v => { answers.scatter = v as WizardAnswers['scatter']; touchWizard(); },
    )));

    contentEl.appendChild(features);
    contentEl.appendChild(summaryStrip());
  }

  function featureRow(label: string, on: boolean, onToggle: (on: boolean) => void, control: HTMLElement | null): HTMLElement {
    const row = el('div', 'wiz-feature-row');
    const toggle = el('label', 'wiz-feature-toggle');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = on;
    cb.addEventListener('change', () => onToggle(cb.checked));
    toggle.appendChild(cb);
    toggle.appendChild(el('span', '', label));
    row.appendChild(toggle);
    if (control) {
      control.classList.add('wiz-feature-control');
      row.appendChild(control);
    }
    return row;
  }

  function regionChip(): HTMLElement {
    const chip = el('div', 'wiz-region-chip');
    const minus = el('button', '', '−') as HTMLButtonElement;
    const plus  = el('button', '', '+') as HTMLButtonElement;
    minus.type = plus.type = 'button';
    const label = el('span', '', `${answers.regionCount} regions`);
    const bump = (d: number) => {
      answers.regionCount = Math.min(4, Math.max(1, answers.regionCount + d));
      label.textContent = `${answers.regionCount} regions`;
      touchWizard();
    };
    minus.addEventListener('click', () => bump(-1));
    plus.addEventListener('click', () => bump(1));
    chip.appendChild(minus);
    chip.appendChild(label);
    chip.appendChild(plus);
    return chip;
  }

  function summaryStrip(): HTMLElement {
    const size  = resolveSize(answers);
    const strip = el('div', 'wiz-summary');
    const text  = el('div', 'wiz-summary-text');
    text.appendChild(el('div', 'wiz-summary-title',
      `${getShape(answers.shapeId).name} · ${getClimate(answers.climateId).name} · ${size.width} × ${size.height}`));
    text.appendChild(el('div', 'wiz-summary-sub',
      `Seed ${answers.seed} · ${RUGGEDNESS_LABELS[Math.round(answers.ruggedness * (RUGGEDNESS_LABELS.length - 1))]}` +
      ` · ${answers.rivers === 'none' ? 'no' : answers.rivers} rivers`));
    strip.appendChild(text);
    return strip;
  }

  // ---- All-parameters escape hatch ----

  function renderParamsView(): void {
    contentEl.appendChild(stepHeading(
      'All parameters',
      'The wizard answers expanded into the raw generator config. Hand edits win until a wizard control is touched again.',
    ));

    contentEl.appendChild(segmented(
      plugins.map(p => ({ value: p.id, label: p.name })),
      params.pluginId,
      id => {
        const plugin = plugins.find(p => p.id === id)!;
        params = {
          pluginId: id,
          config:   structuredClone(plugin.defaultConfig) as ConfigObj,
          width:    params.width,
          height:   params.height,
        };
        markCustom();
        render();
      },
    ));

    const dims = el('div', 'wiz-custom-size');
    for (const dim of ['width', 'height'] as const) {
      const label = el('label', 'wiz-dim');
      label.appendChild(el('span', '', dim === 'width' ? 'Width' : 'Height'));
      const input = document.createElement('input');
      input.type = 'number';
      input.min = '10'; input.max = '512';
      input.value = String(params[dim]);
      input.addEventListener('change', () => {
        params[dim] = Math.max(10, Math.min(512, parseInt(input.value, 10) || 100));
        markCustom();
        schedulePreview();
      });
      label.appendChild(input);
      dims.appendChild(label);
    }
    contentEl.appendChild(dims);

    const fields = el('div', 'wiz-params-fields');
    fields.id = 'wizard-config-fields';
    const plugin = plugins.find(p => p.id === params.pluginId)!;
    renderConfigFields(fields, plugin.configSchema ?? [], params.config, () => {
      markCustom();
      schedulePreview();
    });
    contentEl.appendChild(fields);
  }

  function markCustom(): void {
    paramsRev++; // every raw edit is a new plan as far as the map cache knows
    if (!custom) {
      custom = true;
      customBadge.classList.remove('hidden');
    }
  }

  // ---- Footer / navigation ----

  function renderFooter(): void {
    if (view === 'params') {
      backBtn.classList.remove('hidden');
      backBtn.innerHTML = '&#8592; Back to wizard';
      createNowBtn.classList.add('hidden');
      paramsBtn.classList.add('hidden');
      nextBtn.textContent = 'Create map';
    } else {
      backBtn.classList.toggle('hidden', step === 0);
      backBtn.innerHTML = '&#8592; Back';
      createNowBtn.classList.toggle('hidden', step === STEP_TITLES.length - 1);
      paramsBtn.classList.remove('hidden');
      nextBtn.textContent = step < STEP_TITLES.length - 1
        ? `${STEP_TITLES[step + 1]} →`
        : 'Create map';
    }
    seedValueEl.textContent = String(answers.seed);
  }

  // ---- Create ----

  async function create(): Promise<void> {
    if (busy) return;
    const plan = currentPlan();

    if (plan.pluginId === 'heightmap' && !(plan.config as { image?: unknown }).image) {
      alert('Please choose a heightmap image first (All parameters → Heightmap).');
      return;
    }

    busy = true;
    const restore = nextBtn.textContent;
    for (const b of [nextBtn, backBtn, createNowBtn, cancelBtn, paramsBtn, closeBtn]) b.disabled = true;

    try {
      // Same cache the preview and cards use — if the preview already
      // generated this map, Create hands over that exact map instantly.
      const map = await getMapAsync(plan, answers.seed, f => {
        nextBtn.textContent = `Generating… ${Math.round(f * 100)}%`;
      });
      takeMap(plan, answers.seed); // the scene owns and mutates it from here
      if (!custom) applyScatterDensity(map, answers.scatter);
      dialog.close();
      opts.onCreate({ map, pluginId: plan.pluginId, seed: answers.seed });
    } finally {
      busy = false;
      nextBtn.textContent = restore;
      for (const b of [nextBtn, backBtn, createNowBtn, cancelBtn, paramsBtn, closeBtn]) b.disabled = false;
    }
  }

  // ---- Wiring ----

  closeBtn.addEventListener('click', () => { if (!busy) dialog.close(); });
  cancelBtn.addEventListener('click', () => { if (!busy) dialog.close(); });
  dialog.addEventListener('click', e => { if (e.target === dialog && !busy) dialog.close(); });
  dialog.addEventListener('cancel', e => { if (busy) e.preventDefault(); });

  q<HTMLButtonElement>('wiz-reroll-btn').addEventListener('click', () => {
    answers.seed = Math.floor(Math.random() * 0xffffffff);
    seedValueEl.textContent = String(answers.seed);
    // Thumbnails bake the seed in, so the shape step needs a full re-render.
    if (view === 'wizard' && step === 0) render();
    else schedulePreview();
  });

  paramsBtn.addEventListener('click', () => {
    if (!custom) params = compileWizard(answers);
    view = 'params';
    render();
  });

  backBtn.addEventListener('click', () => {
    if (view === 'params') { view = 'wizard'; render(); return; }
    if (step > 0) goToStep(step - 1);
  });

  nextBtn.addEventListener('click', () => {
    if (view === 'params' || step === STEP_TITLES.length - 1) { void create(); return; }
    goToStep(step + 1);
  });

  createNowBtn.addEventListener('click', () => { void create(); });

  // ---- Render root ----

  function render(): void {
    renderStepper();
    contentEl.innerHTML = '';
    if (view === 'params') {
      renderParamsView();
    } else {
      switch (step) {
        case 0: renderShapeStep(); break;
        case 1: renderClimateStep(); break;
        case 2: renderDetailStep(); break;
        default: renderSizeStep(); break;
      }
    }
    renderFooter();
    schedulePreview();
  }

  return {
    open(): void {
      render();
      dialog.showModal();
    },
  };
}
