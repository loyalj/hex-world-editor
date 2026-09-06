// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { ScatterAssetDescriptor, ScatterDescriptor } from '@loyalj/hex-world';
import { PALM_RECIPE } from '@loyalj/hex-world';
import { initScatterBuilder } from '../src/ui/scatterBuilder.ts';
import { SCATTER_LAYER_NAMES, defaultScatter } from '../src/scatterRoster.ts';
import type { SceneApi } from '../src/scene.ts';
import { loadEditorDom, makeScene } from './helpers.ts';

let setScatter: ReturnType<typeof vi.fn>;
let onChanged: Mock<() => void>;
let api: ReturnType<typeof initScatterBuilder>;

const click = (id: string): void => { (document.getElementById(id) as HTMLButtonElement).click(); };
const type  = (id: string, value: string): void => {
  const el = document.getElementById(id) as HTMLInputElement;
  el.value = value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
};

beforeEach(() => {
  vi.useFakeTimers();
  loadEditorDom();
  const s = makeScene();
  setScatter = vi.fn();
  onChanged  = vi.fn();
  api = initScatterBuilder({
    scene: Object.assign(s, { setScatter, scatterDescriptors: [], scatterAssets: [] }) as unknown as SceneApi,
    terrains: () => [{ index: 0, id: 'grass', name: 'Grass', color: 0x88bb88, texture: { type: 'procedural' } }],
    onChanged: () => onChanged(),
  });
});

describe('Scatter Builder', () => {
  it('starts from the editor defaults and names every layer', () => {
    expect(api.descriptors.map(d => d.id)).toEqual(['pine', 'rock', 'broadleaf', 'bush']);
    expect(api.assets.map(a => a.type)).toEqual(['shape', 'shape', 'shape', 'shape']);
    expect(SCATTER_LAYER_NAMES.slice(0, 4)).toEqual(['Pine Trees', 'Rocks', 'Broadleaf Trees', 'Bushes']);
  });

  it('adds a palm from its template on the first free layer and pushes it to the scene', () => {
    api.open();
    (document.getElementById('scatter-template') as HTMLSelectElement).value = 'palm';
    click('scatter-add-btn');
    const palm = api.descriptors.find(d => d.id === 'palms')!;
    expect(palm).toBeDefined();
    expect(palm.layerIndex).toBe(3); // makeScene has 4 layers, all in use, so the last one
    expect(palm.placement).toEqual({ shore: true });
    const asset = api.assets.find(a => a.id === 'palms-shape')!;
    expect(asset.recipe).toEqual(PALM_RECIPE);
    expect(asset.material?.doubleSide).toBe(true);
    // The push is debounced; nothing reaches the scene until the timer fires.
    expect(setScatter).not.toHaveBeenCalled();
    vi.runAllTimers();
    expect(setScatter).toHaveBeenCalledTimes(1);
    const [assets, descriptors] = setScatter.mock.calls[0] as [ScatterAssetDescriptor[], ScatterDescriptor[]];
    expect(descriptors.some(d => d.id === 'palms')).toBe(true);
    expect(assets.some(a => a.id === 'palms-shape')).toBe(true);
    expect(onChanged).toHaveBeenCalled();
    expect(SCATTER_LAYER_NAMES[palm.layerIndex]).toContain('Palms');
  });

  it('edits the selected type through the form: name, tiers, placement, behaviour', () => {
    api.open();
    type('scatter-name', 'Firs');
    type('scatter-scale-1', '0.6');
    type('scatter-elev-min', '3');
    (document.getElementById('scatter-avoid-rivers') as HTMLInputElement).checked = true;
    document.getElementById('scatter-avoid-rivers')!.dispatchEvent(new Event('change'));
    (document.getElementById('scatter-seasons') as HTMLInputElement).checked = true;
    document.getElementById('scatter-seasons')!.dispatchEvent(new Event('change'));
    type('scatter-blossom', '0.4');
    vi.runAllTimers();

    const pine = api.descriptors[0];
    expect(pine.name).toBe('Firs');
    expect(pine.tiers[1][0].scale).toBe(0.6);
    expect(pine.placement).toEqual({ minElevation: 3, avoidRivers: true });
    const asset = api.assets[0];
    expect(asset.material?.seasonalTint).toEqual({ blossomShare: 0.4 });
    expect(asset.material?.windSway).toBeTruthy();   // the template's wind survives a form round-trip
    expect(setScatter).toHaveBeenCalled();
  });

  it('edits recipe parts and keeps the recipe valid', () => {
    api.open();
    click('scatter-part-add');
    const pineRecipe = api.assets[0].recipe!;
    expect(pineRecipe.parts).toHaveLength(2);
    const firstInput = document.querySelector<HTMLInputElement>('#scatter-parts .scatter-part-triple input')!;
    firstInput.value = '0.9';
    firstInput.dispatchEvent(new Event('input'));
    expect((pineRecipe.parts[0].size as number[])[0]).toBe(0.9);
    // Removing down to one part is allowed; the last one cannot go.
    const removeButtons = document.querySelectorAll<HTMLButtonElement>('#scatter-parts .scatter-part-tools button[title="Remove"]');
    removeButtons[1].click();
    expect(pineRecipe.parts).toHaveLength(1);
    expect(document.querySelector<HTMLButtonElement>('#scatter-parts .scatter-part-tools button[title="Remove"]')!.disabled).toBe(true);
  });

  it('duplicates and deletes, dropping an asset only when nothing uses it', () => {
    api.open();
    click('scatter-dup-btn');
    expect(api.descriptors).toHaveLength(5);
    expect(api.assets).toHaveLength(5);
    vi.stubGlobal('confirm', () => true);
    click('scatter-del-btn');
    expect(api.descriptors).toHaveLength(4);
    expect(api.assets).toHaveLength(4);
  });

  it('adopts a loaded set, keeps the current one for descriptor-only files, and resets on empty', () => {
    const loaded = defaultScatter();
    loaded.descriptors = [loaded.descriptors[2]];
    loaded.assets = [loaded.assets[2]];
    api.applyLoaded(loaded.assets, loaded.descriptors);
    expect(api.descriptors.map(d => d.id)).toEqual(['broadleaf']);
    expect(setScatter).toHaveBeenCalledTimes(1);

    api.applyLoaded([], [{ id: 'old', name: 'Old', layerIndex: 0, tiers: [[{ assetId: 'pine-dense', yOffset: 0 }]] }]);
    expect(api.descriptors.map(d => d.id)).toEqual(['broadleaf']);

    api.applyLoaded([], []);
    expect(api.descriptors.map(d => d.id)).toEqual(['pine', 'rock', 'broadleaf', 'bush']);
  });
});
