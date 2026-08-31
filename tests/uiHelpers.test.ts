// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildChipRow, wireBrushGroup, wireOptionGroup } from '../src/ui/uiHelpers.ts';

beforeEach(() => {
  document.body.innerHTML = `
    <div id="group">
      <button class="opt active" data-kind="a">A</button>
      <button class="opt" data-kind="b">B</button>
      <button class="opt" data-kind="c">C</button>
    </div>
    <div id="brushes">
      <button class="brush-btn active" data-brush="0"></button>
      <button class="brush-btn" data-brush="2"></button>
    </div>`;
});

describe('wireOptionGroup', () => {
  it('moves the active class and reports the clicked button', () => {
    const picks: string[] = [];
    const btns = wireOptionGroup('#group .opt', btn => picks.push(btn.dataset['kind']!));

    btns[1].click();
    expect(picks).toEqual(['b']);
    expect([...btns].map(b => b.classList.contains('active'))).toEqual([false, true, false]);

    btns[2].click();
    expect(picks).toEqual(['b', 'c']);
    expect(btns[1].classList.contains('active')).toBe(false);
    expect(btns[2].classList.contains('active')).toBe(true);
  });
});

describe('wireBrushGroup', () => {
  it('parses the data-brush radius into the callback', () => {
    const radii: number[] = [];
    wireBrushGroup('brushes', r => radii.push(r));
    document.querySelectorAll<HTMLButtonElement>('#brushes .brush-btn')[1].click();
    expect(radii).toEqual([2]);
  });
});

describe('buildChipRow', () => {
  it('builds a labelled colour chip that fires on click', () => {
    const onPick = vi.fn();
    const row = buildChipRow('red', 'Kelmar', 0xdd4433, true, onPick);

    expect(row.classList.contains('active')).toBe(true);
    expect(row.querySelector('.swatch-name')!.textContent).toBe('Kelmar');
    expect((row.querySelector('.swatch-chip') as HTMLElement).style.background).toBeTruthy();

    row.click();
    expect(onPick).toHaveBeenCalledOnce();
  });

  it('leaves the active class off unselected rows', () => {
    const row = buildChipRow('blue', 'Ossiran', 0x3377dd, false, () => {});
    expect(row.classList.contains('active')).toBe(false);
  });
});
