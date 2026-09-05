import { MAX_BRUSH_RADIUS, expectedCells } from '../tools/brushFootprint.ts';
import type { BrushSettings, BrushShape } from '../tools/brushFootprint.ts';
import { wireOptionGroup } from './uiHelpers.ts';

/**
 * The shared brush controls a stamp tool's panel carries: a shape segmented
 * control, a size slider with a cell-count readout, a hardness slider for
 * the solid shape, and a density slider for the spray. The tool reads
 * {@link settings} and hands `[` / `]` keys to {@link keyDown}.
 */
export interface BrushControls {
  /** Live settings — the tool reads these on every stamp. */
  readonly settings: BrushSettings;
  /** Move the radius, clamped to the slider's range; slider and readout follow. */
  setRadius(radius: number): void;
  /** `[` and `]` step the size (Shift steps by 5). True when consumed. */
  keyDown(e: KeyboardEvent): boolean;
}

/**
 * Wire one panel's brush controls. Elements are found by id from a prefix:
 * `${prefix}-shape-group`, `${prefix}-brush-size` (+ `-value`),
 * `${prefix}-hardness-row` / `-hardness` / `-hardness-value`, and
 * `${prefix}-density-row` / `-density` / `-density-value`. `onChange` fires
 * after any change so the tool can resync the hover footprint.
 */
export function wireBrushControls(prefix: string, onChange: () => void): BrushControls {
  const el = <T extends HTMLElement>(suffix: string): T => document.getElementById(`${prefix}-${suffix}`) as T;
  const settings: BrushSettings = { radius: 0, shape: 'solid', hardness: 1, density: 0.5 };

  const sizeInput = el<HTMLInputElement>('brush-size');
  const sizeValue = el<HTMLElement>('brush-size-value');
  const hardnessRow   = el<HTMLElement>('hardness-row');
  const hardnessInput = el<HTMLInputElement>('hardness');
  const hardnessValue = el<HTMLElement>('hardness-value');
  const densityRow   = el<HTMLElement>('density-row');
  const densityInput = el<HTMLInputElement>('density');
  const densityValue = el<HTMLElement>('density-value');

  /** "3 · 37 cells" for a solid brush; the ring's band or the spray's average otherwise. */
  function updateReadout(): void {
    const n = expectedCells(settings);
    const cells = settings.shape === 'spray' ? `~${n}` : String(n);
    sizeValue.textContent = `${settings.radius} · ${cells} cell${n === 1 ? '' : 's'}`;
  }

  function setRadius(radius: number): void {
    settings.radius = Math.max(0, Math.min(MAX_BRUSH_RADIUS, Math.round(radius)));
    sizeInput.value = String(settings.radius);
    updateReadout();
    onChange();
  }

  sizeInput.max = String(MAX_BRUSH_RADIUS);
  sizeInput.addEventListener('input', () => setRadius(parseInt(sizeInput.value, 10) || 0));

  hardnessInput.addEventListener('input', () => {
    settings.hardness = (parseInt(hardnessInput.value, 10) || 0) / 100;
    hardnessValue.textContent = `${Math.round(settings.hardness * 100)}%`;
    onChange();
  });
  densityInput.addEventListener('input', () => {
    settings.density = (parseInt(densityInput.value, 10) || 0) / 100;
    densityValue.textContent = `${Math.round(settings.density * 100)}%`;
    updateReadout();
    onChange();
  });

  wireOptionGroup(`#${prefix}-shape-group .scatter-type-btn`, btn => {
    settings.shape = btn.dataset['brushShape'] as BrushShape;
    // Hardness only shapes a solid rim; density only means something to spray.
    hardnessRow.classList.toggle('hidden', settings.shape !== 'solid');
    densityRow.classList.toggle('hidden', settings.shape !== 'spray');
    updateReadout();
    onChange();
  });

  updateReadout();

  return {
    settings,
    setRadius,
    keyDown(e: KeyboardEvent): boolean {
      if (e.ctrlKey || e.metaKey || e.altKey) return false;
      if (e.key !== '[' && e.key !== ']' && e.key !== '{' && e.key !== '}') return false;
      const step = e.shiftKey ? 5 : 1;
      setRadius(settings.radius + (e.key === ']' || e.key === '}' ? step : -step));
      return true;
    },
  };
}
