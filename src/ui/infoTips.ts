/** A hover/focus tooltip trigger — a subtle glyph that reveals `text` on a card. */
export function buildInfoTip(text: string): HTMLElement {
  const tip = document.createElement('span');
  tip.className = 'info-tip';
  tip.tabIndex = 0;
  tip.setAttribute('aria-label', text);
  tip.innerHTML =
    '<svg viewBox="0 0 16 16" aria-hidden="true">'
    + '<circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" stroke-width="1.2"/>'
    + '<path d="M8 7.2v4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>'
    + '<circle cx="8" cy="4.9" r="0.85" fill="currentColor"/>'
    + '</svg>';
  const panel = document.createElement('span');
  panel.className = 'info-tip-panel';
  panel.setAttribute('role', 'tooltip');
  panel.textContent = text;
  tip.appendChild(panel);

  // The panel is fixed-position so the drawer's scroll box can't clip it; that
  // means placing it by hand, flipping above the glyph when the bottom is tight.
  const place = (): void => {
    const anchor = tip.getBoundingClientRect();
    const box = panel.getBoundingClientRect();
    let top = anchor.bottom + 7;
    if (top + box.height > window.innerHeight - 8) top = Math.max(8, anchor.top - 7 - box.height);
    const left = Math.max(8, Math.min(anchor.left - 4, window.innerWidth - 8 - box.width));
    panel.style.top  = `${top}px`;
    panel.style.left = `${left}px`;
  };
  tip.addEventListener('pointerenter', place);
  tip.addEventListener('focus', place);
  // Several tips live inside <label>s, where a stray click would flip the checkbox.
  tip.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); });
  return tip;
}

/** Turn every `data-tip="…"` marker in the static markup into a tooltip glyph. */
export function hydrateInfoTips(): void {
  document.querySelectorAll<HTMLElement>('[data-tip]').forEach(host => {
    const text = host.dataset['tip'];
    host.removeAttribute('data-tip');
    if (text) host.appendChild(buildInfoTip(text));
  });
}

/** Replace the text of an already-hydrated tip (the river hint tracks the mode). */
export function setInfoTipText(host: HTMLElement, text: string): void {
  const tip = host.querySelector<HTMLElement>('.info-tip');
  if (!tip) return;
  tip.setAttribute('aria-label', text);
  tip.querySelector('.info-tip-panel')!.textContent = text;
}
