// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest';
import {
  applyTheme, initSettings, loadStoredTheme, DEFAULT_THEME, THEME_PRESETS,
} from '../src/ui/settings.ts';
import type { ThemeSettings } from '../src/ui/settings.ts';
import { clickOption, loadEditorDom, setInput } from './helpers.ts';

const PAPER = THEME_PRESETS.find(p => p.id === 'paper')!.theme;

const rootVar = (name: string) => document.documentElement.style.getPropertyValue(name);
const presetCards = () => [...document.querySelectorAll<HTMLElement>('.theme-preset')];
const activeCards = () => presetCards().filter(c => c.classList.contains('active'));

beforeEach(() => {
  localStorage.clear();
  loadEditorDom();
  document.documentElement.removeAttribute('style');
});

describe('applyTheme token derivation', () => {
  it('derives the accent and surface tokens in oklch', () => {
    applyTheme(DEFAULT_THEME);
    expect(rootVar('--accent')).toBe('oklch(62.0% 0.210 259)');
    expect(rootVar('--bg')).toContain('19.0%');
    expect(rootVar('--accent-soft')).toContain('/ 0.16');
  });

  it('light mode flips the surface ramp and native color scheme', () => {
    applyTheme(PAPER);
    expect(rootVar('--bg')).toContain('95.5%');
    expect(rootVar('--fg')).toContain('22.0%');
    expect(document.documentElement.style.colorScheme).toBe('light');
  });

  it('scales the radius tokens, and "none" squares the pills too', () => {
    applyTheme(DEFAULT_THEME);
    expect(rootVar('--r-card')).toBe('24px');
    expect(rootVar('--r-pill')).toBe('999px');
    applyTheme({ ...DEFAULT_THEME, radius: 'none' });
    expect(rootVar('--r-control')).toBe('0px');
    expect(rootVar('--r-pill')).toBe('0px');
    applyTheme({ ...DEFAULT_THEME, radius: 'lg' });
    expect(rootVar('--r-card')).toBe('34px');
  });
});

describe('settings dialog', () => {
  it('applies the stored theme on init and marks the matching preset', () => {
    initSettings();
    expect(rootVar('--accent')).toContain('259');
    expect(presetCards()).toHaveLength(THEME_PRESETS.length);
    expect(activeCards().map(c => c.dataset['preset'])).toEqual(['graphite']);
  });

  it('a preset click applies its theme and persists it across init', () => {
    initSettings();
    clickOption('.theme-preset[data-preset="paper"]');
    expect(rootVar('--bg')).toContain('95.5%');
    expect(loadStoredTheme().mode).toBe('light');

    // A fresh session (fresh DOM, same storage) comes back in the same theme.
    loadEditorDom();
    document.documentElement.removeAttribute('style');
    const api = initSettings();
    expect(api.theme()).toEqual(PAPER);
    expect(rootVar('--bg')).toContain('95.5%');
  });

  it('tweaking a slider re-derives the accent and drifts off the preset', () => {
    initSettings();
    setInput('theme-accent-hue', '120');
    expect(rootVar('--accent')).toContain('120');
    expect(activeCards()).toHaveLength(0);
    expect(loadStoredTheme().accentHue).toBe(120);
  });

  it('the radius segmented control drives the radius tokens', () => {
    initSettings();
    clickOption('#theme-radius-group [data-theme-radius="none"]');
    expect(rootVar('--r-control')).toBe('0px');
    clickOption('#theme-radius-group [data-theme-radius="md"]');
    expect(rootVar('--r-control')).toBe('12px');
  });

  it('reset returns to the default theme from any preset', () => {
    initSettings();
    clickOption('.theme-preset[data-preset="orchid"]');
    clickOption('#theme-reset-btn');
    expect(loadStoredTheme()).toEqual(DEFAULT_THEME);
    expect(activeCards().map(c => c.dataset['preset'])).toEqual(['graphite']);
  });

  it('a stored theme from an older shape merges over the defaults', () => {
    localStorage.setItem('hex-world-editor:ui', JSON.stringify({ theme: { accentHue: 30 } }));
    const merged: ThemeSettings = loadStoredTheme();
    expect(merged.accentHue).toBe(30);
    expect(merged.radius).toBe(DEFAULT_THEME.radius);
  });
});
