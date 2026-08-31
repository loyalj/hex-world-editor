/**
 * Wire a group of buttons where exactly one is active at a time. Clicking a
 * button moves the `active` class to it and reports the pick. Returns the
 * button list so callers can re-highlight programmatically (eyedroppers).
 */
export function wireOptionGroup(
  selector: string,
  onPick: (btn: HTMLButtonElement) => void,
): NodeListOf<HTMLButtonElement> {
  const btns = document.querySelectorAll<HTMLButtonElement>(selector);
  btns.forEach(btn => {
    btn.addEventListener('click', () => {
      btns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      onPick(btn);
    });
  });
  return btns;
}

/** A `.brush-btn` radius group: buttons carry `data-brush` with the radius. */
export function wireBrushGroup(groupId: string, onPick: (radius: number) => void): void {
  wireOptionGroup(`#${groupId} .brush-btn`, btn => onPick(parseInt(btn.dataset['brush']!, 10)));
}

/** A colour-chip palette row, matching the terrain palette's look. */
export function buildChipRow(
  id: string, name: string, color: number, selected: boolean,
  onPick: () => void,
): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.className = 'swatch-row';
  btn.dataset['id'] = id;
  btn.title = name;
  if (selected) btn.classList.add('active');

  const chip = document.createElement('span');
  chip.className = 'swatch-chip';
  chip.style.background = `#${color.toString(16).padStart(6, '0')}`;
  btn.appendChild(chip);

  const label = document.createElement('span');
  label.className = 'swatch-name';
  label.textContent = name;
  btn.appendChild(label);

  btn.addEventListener('click', onPick);
  return btn;
}
