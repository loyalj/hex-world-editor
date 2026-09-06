import {
  PINE_RECIPE, BROADLEAF_RECIPE, BUSH_RECIPE, ROCK_RECIPE, PALM_RECIPE, SMOKE_RECIPE,
} from '@loyalj/hex-world';
import type { ScatterAssetDescriptor, ScatterDescriptor, ScatterRecipe, ScatterMaterialDescriptor } from '@loyalj/hex-world';

/**
 * The editor's scatter set as data: one asset (a shape recipe plus material
 * behaviour) and one descriptor (layer, tiers, placement) per scatter type.
 * What the Scatter Builder edits, what the scene resolves into definitions,
 * and what a save file or pack records — so a plant composed here comes back
 * from a load with its wind and seasons intact.
 */

/** Feature layers every map the editor makes carries — room for the four defaults and a couple of the builder's own. */
export const FEATURE_LAYERS = 6;

/** A ready-made scatter type the builder can start from. */
export interface ScatterTemplate {
  id: string;
  name: string;
  recipe: ScatterRecipe;
  material: ScatterMaterialDescriptor;
  tiltStrength?: number;
  placement?: ScatterDescriptor['placement'];
  /** Per-tier scales, dense → sparse. */
  scales: [number, number, number];
  yOffset?: number;
}

export const SCATTER_TEMPLATES: ScatterTemplate[] = [
  {
    id: 'pine', name: 'Pine Trees',
    recipe: { ...PINE_RECIPE, parts: [{ ...PINE_RECIPE.parts[0], color: 0x3f6b2c }] },
    // A stiff conifer barely moves — which is exactly why it gets the call.
    material: { windSway: { height: 2.0, stiffness: 2.6, amplitude: 0.035, flutter: 0.2 }, scatterTexture: 1, scatterTextureScale: 5 },
    scales: [1, 0.75, 0.5],
  },
  {
    id: 'rock', name: 'Rocks',
    recipe: { ...ROCK_RECIPE, parts: [{ ...ROCK_RECIPE.parts[0], color: 0x8a7a6a }] },
    // createRockMaterial squashes and stretches each instance from a hash of
    // its own position, so two rocks off the same geometry aren't the same rock.
    material: { rock: true, color: 0x8a7a6a, scatterTexture: 1, scatterTextureScale: 9 },
    tiltStrength: 0.4,
    scales: [1.2, 0.95, 0.75],
    yOffset: -0.02,
  },
  {
    id: 'broadleaf', name: 'Broadleaf Trees',
    recipe: BROADLEAF_RECIPE,
    // Blossom rides along with the tint — a share of the wood flowers pink or
    // blue as spring passes through, then goes green for the summer.
    material: { seasonalTint: { blossomShare: 0.6 }, windSway: { height: 1.9, stiffness: 2.0, amplitude: 0.07 }, scatterTexture: 1, scatterTextureScale: 6 },
    tiltStrength: 0.05,
    scales: [1.05, 0.78, 0.55],
  },
  {
    id: 'bush', name: 'Bushes',
    recipe: BUSH_RECIPE,
    // Foliage all the way down: skip the green test that keeps the tint off a trunk.
    material: { seasonalTint: { select: 0, variance: 0.35, blossomShare: 0.3 }, windSway: { height: 0.6, stiffness: 1.2, amplitude: 0.125, flutter: 0.6 }, scatterTexture: 1, scatterTextureScale: 11 },
    tiltStrength: 0.12,
    scales: [1.25, 0.95, 0.65],
  },
  {
    id: 'palm', name: 'Palms',
    recipe: PALM_RECIPE,
    material: { doubleSide: true, windSway: { height: 2.6, stiffness: 1.6, amplitude: 0.09, flutter: 0.5 }, scatterTexture: 0.6, scatterTextureScale: 6 },
    tiltStrength: 0.12,
    placement: { shore: true },
    scales: [1, 0.8, 0.6],
  },
  {
    id: 'smoke', name: 'Smoke',
    recipe: SMOKE_RECIPE,
    material: { opacity: 0.6, snow: false, windSway: { height: 2.4, stiffness: 1.0, amplitude: 0.12 } },
    scales: [1.25, 0.9, 0.6],
  },
];

/** Three tiers of one asset at three scales — how every template gets its sizes. */
export function tiersFor(assetId: string, scales: [number, number, number], yOffset = 0): ScatterDescriptor['tiers'] {
  return scales.map(scale => [{ assetId, yOffset, ...(scale !== 1 ? { scale } : {}) }]);
}

/** Build a fresh asset + descriptor pair from a template, on a layer of the caller's choosing. */
export function fromTemplate(t: ScatterTemplate, id: string, name: string, layerIndex: number): { asset: ScatterAssetDescriptor; descriptor: ScatterDescriptor } {
  const assetId = `${id}-shape`;
  return {
    asset: { id: assetId, name, type: 'shape', recipe: structuredClone(t.recipe), material: structuredClone(t.material) },
    descriptor: {
      id, name, layerIndex,
      tiers: tiersFor(assetId, t.scales, t.yOffset ?? 0),
      ...(t.tiltStrength !== undefined ? { tiltStrength: t.tiltStrength } : {}),
      ...(t.placement ? { placement: structuredClone(t.placement) } : {}),
    },
  };
}

/** The set a new editor session starts with: layers 0–3 as the generators fill them. */
export function defaultScatter(): { assets: ScatterAssetDescriptor[]; descriptors: ScatterDescriptor[] } {
  const assets: ScatterAssetDescriptor[] = [];
  const descriptors: ScatterDescriptor[] = [];
  for (const [layer, tid] of [[0, 'pine'], [1, 'rock'], [2, 'broadleaf'], [3, 'bush']] as const) {
    const t = SCATTER_TEMPLATES.find(x => x.id === tid)!;
    const { asset, descriptor } = fromTemplate(t, t.id, t.name, layer);
    assets.push(asset);
    descriptors.push(descriptor);
  }
  return { assets, descriptors };
}

/**
 * Feature layer index → the names of the scatter types on it, for the
 * scatter brush and the resource rules' status text. Mutated in place by
 * {@link refreshLayerNames} so every importer sees the current roster.
 */
export const SCATTER_LAYER_NAMES: string[] = [];

export function refreshLayerNames(descriptors: readonly ScatterDescriptor[]): void {
  SCATTER_LAYER_NAMES.length = 0;
  for (const d of descriptors) {
    const prev = SCATTER_LAYER_NAMES[d.layerIndex];
    SCATTER_LAYER_NAMES[d.layerIndex] = prev ? `${prev} + ${d.name}` : d.name;
  }
  for (let i = 0; i < SCATTER_LAYER_NAMES.length; i++) SCATTER_LAYER_NAMES[i] ??= `Layer ${i}`;
}

refreshLayerNames(defaultScatter().descriptors);
