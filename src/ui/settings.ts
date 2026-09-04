import { loadUiPrefValue, storeUiPrefValue } from './uiPrefs.ts';

/**
 * The File ▸ Settings… modal and the theme system behind it. Every color and
 * radius in style.css routes through a :root custom property, so a theme is
 * just a small set of OKLCH inputs — accent (hue/chroma/lightness), a base
 * tint over the neutral surface ramp, dark or light mode, and a corner-radius
 * scale — from which applyTheme derives the full token set and writes it as
 * inline overrides on <html>. Presets are plain ThemeSettings values; tweaking
 * a slider after picking one simply drifts off the preset (its card unlights
 * when no preset matches the current values). The choice persists per browser
 * via uiPrefs, like panel visibility.
 */

export type ThemeMode = 'dark' | 'light';
export type ThemeRadius = 'none' | 'xs' | 'sm' | 'md' | 'lg';

export interface ThemeSettings {
  mode: ThemeMode;
  /** Accent in OKLCH — hue 0–360, chroma 0–0.3, lightness 0.45–0.85. */
  accentHue: number;
  accentChroma: number;
  accentLightness: number;
  /** Tint over the neutral surfaces — hue 0–360, chroma 0–0.06. */
  baseHue: number;
  baseChroma: number;
  radius: ThemeRadius;
}

export interface ThemePreset {
  id: string;
  label: string;
  theme: ThemeSettings;
}

export const THEME_PRESETS: ThemePreset[] = [
  // Graphite is the stylesheet's own palette (HeroUI-dark zinc + blue) — the
  // default, and what Reset returns to.
  { id: 'graphite', label: 'Graphite', theme: { mode: 'dark',  accentHue: 259, accentChroma: 0.21, accentLightness: 0.62, baseHue: 286, baseChroma: 0.004, radius: 'md' } },
  { id: 'midnight', label: 'Midnight', theme: { mode: 'dark',  accentHue: 215, accentChroma: 0.14, accentLightness: 0.72, baseHue: 262, baseChroma: 0.03,  radius: 'md' } },
  { id: 'verdant',  label: 'Verdant',  theme: { mode: 'dark',  accentHue: 152, accentChroma: 0.14, accentLightness: 0.72, baseHue: 160, baseChroma: 0.016, radius: 'md' } },
  { id: 'ember',    label: 'Ember',    theme: { mode: 'dark',  accentHue: 62,  accentChroma: 0.15, accentLightness: 0.72, baseHue: 60,  baseChroma: 0.012, radius: 'md' } },
  { id: 'orchid',   label: 'Orchid',   theme: { mode: 'dark',  accentHue: 315, accentChroma: 0.19, accentLightness: 0.68, baseHue: 315, baseChroma: 0.02,  radius: 'md' } },
  { id: 'paper',    label: 'Paper',    theme: { mode: 'light', accentHue: 259, accentChroma: 0.17, accentLightness: 0.55, baseHue: 260, baseChroma: 0.006, radius: 'md' } },
];

export const DEFAULT_THEME: ThemeSettings = THEME_PRESETS[0].theme;

const THEME_PREF = 'theme';

// ---- Token derivation ----

/** Corner-radius scale, applied to the stylesheet's default pixel values. */
const RADIUS_FACTOR: Record<ThemeRadius, number> = { none: 0, xs: 0.45, sm: 0.7, md: 1, lg: 1.4 };
const RADIUS_TOKENS: Array<[name: string, px: number]> = [
  ['--r-card', 24], ['--r-inner', 16], ['--r-menu', 14], ['--r-control', 12], ['--r-sm', 10],
];

function oklch(l: number, c: number, h: number, alpha = 1): string {
  const lch = `${(l * 100).toFixed(1)}% ${c.toFixed(3)} ${Math.round(h)}`;
  return alpha >= 1 ? `oklch(${lch})` : `oklch(${lch} / ${alpha})`;
}

/** The accent as a CSS color — preset cards and the preview swatch use it. */
export function accentColor(t: ThemeSettings): string {
  return oklch(t.accentLightness, t.accentChroma, t.accentHue);
}

/** The background as a CSS color — preset cards use it. */
export function baseColor(t: ThemeSettings): string {
  return oklch(t.mode === 'dark' ? 0.19 : 0.955, t.baseChroma, t.baseHue);
}

/** Derive every themed token from the settings and set them on the root. */
export function applyTheme(t: ThemeSettings, root: HTMLElement = document.documentElement): void {
  const dark = t.mode === 'dark';
  const bh = t.baseHue;
  const bc = t.baseChroma;
  const surface = (l: number, c = bc) => oklch(l, c, bh);

  // Lightness ramps chosen to reproduce the stylesheet's zinc values at zero
  // tint; the foreground ramp carries a fraction of the tint so text stays
  // near-neutral even on a strongly tinted base.
  const vars: Record<string, string> = dark
    ? {
        '--bg':        surface(0.19),
        '--surface':   surface(0.265),
        '--surface-2': surface(0.30),
        '--surface-3': surface(0.353),
        '--segment':   surface(0.43),
        '--divider':   surface(0.32),
        '--fg':        surface(0.985, bc / 4),
        '--fg-2':      surface(0.87,  bc / 3),
        '--fg-muted':  surface(0.71,  bc / 2),
        '--fg-subtle': surface(0.55,  bc / 2),
        '--accent-fg': oklch(0.80, Math.min(t.accentChroma * 0.7, 0.12), t.accentHue),
        '--danger':    '#ff6b6b',
        '--shadow-menu': '0 0 1px 0 rgba(255, 255, 255, 0.3) inset, 0 16px 40px rgba(0, 0, 0, 0.6)',
      }
    : {
        '--bg':        surface(0.955),
        '--surface':   surface(0.988, bc / 2),
        '--surface-2': surface(0.93),
        '--surface-3': surface(0.885),
        // The active pill inside a segmented track: white card on the grey track.
        '--segment':   surface(0.999, 0),
        '--divider':   surface(0.90),
        '--fg':        surface(0.22, bc / 2),
        '--fg-2':      surface(0.33, bc / 2),
        '--fg-muted':  surface(0.50, bc / 2),
        '--fg-subtle': surface(0.62, bc / 2),
        '--accent-fg': oklch(0.44, Math.min(t.accentChroma + 0.02, 0.19), t.accentHue),
        '--danger':    '#c93b3b',
        '--shadow-menu': '0 0 0 1px rgba(17, 17, 20, 0.06), 0 12px 32px rgba(17, 17, 20, 0.16)',
      };

  vars['--accent']      = accentColor(t);
  vars['--accent-soft'] = oklch(t.accentLightness, t.accentChroma, t.accentHue, dark ? 0.16 : 0.15);
  vars['--accent-weak'] = oklch(t.accentLightness, t.accentChroma, t.accentHue, dark ? 0.12 : 0.10);

  const factor = RADIUS_FACTOR[t.radius];
  for (const [name, px] of RADIUS_TOKENS) vars[name] = `${Math.round(px * factor)}px`;
  vars['--r-pill'] = t.radius === 'none' ? '0px' : '999px';

  for (const [name, value] of Object.entries(vars)) root.style.setProperty(name, value);
  root.style.colorScheme = t.mode; // native controls (checkboxes, scrollbars) follow
}

/** The stored theme merged over the default — tolerant of older stored shapes. */
export function loadStoredTheme(): ThemeSettings {
  const stored = loadUiPrefValue<Partial<ThemeSettings>>(THEME_PREF);
  return { ...DEFAULT_THEME, ...(stored && typeof stored === 'object' ? stored : {}) };
}

// ---- The Settings modal ----

export interface SettingsApi {
  theme(): ThemeSettings;
}

/** Apply the stored theme and wire File ▸ Settings… and its dialog. */
export function initSettings(): SettingsApi {
  let theme = loadStoredTheme();
  applyTheme(theme);

  const dialog   = document.getElementById('settings-dialog')    as HTMLDialogElement;
  const openBtn  = document.getElementById('settings-btn')       as HTMLButtonElement;
  const closeBtn = document.getElementById('settings-close-btn') as HTMLButtonElement;

  openBtn.addEventListener('click', () => dialog.showModal());
  closeBtn.addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', e => { if (e.target === dialog) dialog.close(); });

  // Each control both drives the theme and re-syncs from it, so preset clicks,
  // slider tweaks, and Reset all funnel through setTheme.
  const syncers: Array<() => void> = [];
  function syncControls(): void {
    for (const sync of syncers) sync();
  }
  function setTheme(next: ThemeSettings): void {
    theme = next;
    applyTheme(theme);
    storeUiPrefValue(THEME_PREF, theme);
    syncControls();
  }

  // Preset cards — two dots (base, accent) plus the name.
  const presetGroup = document.getElementById('theme-preset-group') as HTMLElement;
  const presetBtns = THEME_PRESETS.map(preset => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'theme-preset';
    btn.dataset['preset'] = preset.id;
    const dots = document.createElement('span');
    dots.className = 'theme-preset-dots';
    for (const color of [baseColor(preset.theme), accentColor(preset.theme)]) {
      const dot = document.createElement('span');
      dot.style.background = color;
      dots.appendChild(dot);
    }
    const label = document.createElement('span');
    label.textContent = preset.label;
    btn.append(dots, label);
    btn.addEventListener('click', () => setTheme({ ...preset.theme }));
    presetGroup.appendChild(btn);
    return btn;
  });
  syncers.push(() => {
    for (let i = 0; i < presetBtns.length; i++) {
      const p = THEME_PRESETS[i].theme;
      const matches = (Object.keys(p) as Array<keyof ThemeSettings>).every(k => p[k] === theme[k]);
      presetBtns[i].classList.toggle('active', matches);
    }
  });

  /**
   * A labelled slider bound to one numeric theme field. The DOM works in
   * friendly integers; scale converts them to the stored unit (1 for degrees,
   * 100 for chroma/lightness sliders that store 0–1 fractions).
   */
  function wireSlider(
    id: string,
    field: 'accentHue' | 'accentChroma' | 'accentLightness' | 'baseHue' | 'baseChroma',
    scale: number,
    format: (sliderValue: number) => string,
  ): void {
    const input = document.getElementById(id) as HTMLInputElement;
    const value = document.getElementById(`${id}-value`) as HTMLElement;
    input.addEventListener('input', () => {
      setTheme({ ...theme, [field]: Number(input.value) / scale });
    });
    syncers.push(() => {
      const sliderValue = theme[field] * scale;
      input.value = String(sliderValue);
      value.textContent = format(sliderValue);
    });
  }

  wireSlider('theme-accent-hue',        'accentHue',       1,   v => `${Math.round(v)}°`);
  wireSlider('theme-accent-chroma',     'accentChroma',    100, v => `${Math.round((v / 30) * 100)}%`);
  wireSlider('theme-accent-lightness',  'accentLightness', 100, v => `${Math.round(v)}%`);
  wireSlider('theme-base-hue',          'baseHue',         1,   v => `${Math.round(v)}°`);
  wireSlider('theme-base-chroma',       'baseChroma',      100, v => `${Math.round((v / 6) * 100)}%`);

  // The accent preview swatch tracks the derived --accent via the stylesheet;
  // nothing to sync. Mode and radius are segmented radios.
  function wireSegmented(groupId: string, attr: string, current: () => string, pick: (v: string) => void): void {
    const group = document.getElementById(groupId) as HTMLElement;
    const btns = [...group.querySelectorAll<HTMLButtonElement>('button')];
    for (const btn of btns) {
      btn.addEventListener('click', () => pick(btn.dataset[attr]!));
    }
    syncers.push(() => {
      for (const btn of btns) btn.classList.toggle('active', btn.dataset[attr] === current());
    });
  }

  wireSegmented('theme-mode-group', 'themeMode', () => theme.mode,
    v => setTheme({ ...theme, mode: v as ThemeMode }));
  wireSegmented('theme-radius-group', 'themeRadius', () => theme.radius,
    v => setTheme({ ...theme, radius: v as ThemeRadius }));

  (document.getElementById('theme-reset-btn') as HTMLButtonElement)
    .addEventListener('click', () => setTheme({ ...DEFAULT_THEME }));

  syncControls();

  return { theme: () => theme };
}
