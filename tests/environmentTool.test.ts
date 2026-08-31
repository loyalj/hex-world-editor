// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest';
import { EnvironmentTool } from '../src/tools/environmentTool.ts';
import { loadEditorDom, makeCtx, makeScene, setInput } from './helpers.ts';
import type { FakeScene } from './helpers.ts';

let s: FakeScene;
let tool: EnvironmentTool;

beforeEach(() => {
  loadEditorDom();
  s = makeScene();
  tool = new EnvironmentTool(makeCtx(s).ctx);
});

describe('EnvironmentTool snapshot/restore', () => {
  it('snapshot reflects the panel', () => {
    setInput('tod-slider', '330');
    document.querySelector<HTMLButtonElement>('#weather-type-group button[data-weather="rain"]')!.click();
    setInput('weather-intensity', '80');
    setInput('wind-speed', '5');
    setInput('wind-dir', '90');
    const seasons = document.getElementById('seasons-enable') as HTMLInputElement;
    seasons.checked = true;
    seasons.dispatchEvent(new Event('change'));
    setInput('season-phase', '25');

    const snap = tool.snapshot();
    expect(snap.tod).toBe(330);
    expect(snap.weather).toBe('rain');
    expect(snap.intensity).toBe(80);
    expect(snap.windSpeed).toBe(5);
    expect(snap.windDir).toBe(90);
    expect(snap.seasonsOn).toBe(true);
    expect(snap.seasonPhase).toBe(25);
    expect(snap.seasonScope).toBe('continental');
  });

  it('restore into a fresh panel reproduces the snapshot exactly', () => {
    setInput('tod-slider', '1140');
    document.querySelector<HTMLButtonElement>('#weather-type-group button[data-weather="snow"]')!.click();
    setInput('weather-intensity', '65');
    setInput('wind-speed', '7.5');
    setInput('wind-gust', '55');
    setInput('scatter-texture', '40');
    const animate = document.getElementById('tod-animate') as HTMLInputElement;
    animate.checked = true;
    animate.dispatchEvent(new Event('change'));
    const seasons = document.getElementById('seasons-enable') as HTMLInputElement;
    seasons.checked = true;
    seasons.dispatchEvent(new Event('change'));
    setInput('season-phase', '75');
    const snap = tool.snapshot();

    // A brand-new page: fresh DOM, fresh scene, fresh tool.
    loadEditorDom();
    const s2 = makeScene();
    const tool2 = new EnvironmentTool(makeCtx(s2).ctx);
    tool2.restore(snap);

    expect(tool2.snapshot()).toEqual(snap);
    // The weather button click drove the scene-facing kind, not just the class.
    expect(tool2.statusText()).toContain('snow');
  });

  it('restoring a clear-weather default state is a no-op-safe path', () => {
    const snap = tool.snapshot();
    loadEditorDom();
    const tool2 = new EnvironmentTool(makeCtx(makeScene()).ctx);
    tool2.restore(snap);
    expect(tool2.snapshot()).toEqual(snap);
  });
});
