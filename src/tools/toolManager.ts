import type { CellPos, Tool, ToolContext, ToolId } from './tool.ts';

const TOOL_HOTKEYS: Record<string, ToolId> = {
  '0': 'select',
  '1': 'paint-terrain',
  '2': 'elevation',
  '3': 'paint-river',
  '4': 'paint-road',
  '5': 'paint-scatter',
  '6': 'environment',
  '7': 'paint-territory',
  '8': 'paint-resource',
  '9': 'paint-fog',
  'u': 'paint-unit',
};

export interface ToolManager {
  /** The tool currently receiving pointer input. */
  readonly active: Tool;
  setActive(id: ToolId): void;
}

/**
 * Owns tool switching and routes the viewport's pointer events and the
 * tool-relevant keyboard events to the active tool. Also completes the shared
 * ToolContext: `syncBrushRadius` and `updateCursor` are stubs until here.
 */
export function initToolManager(
  ctx: ToolContext,
  tools: Tool[],
  viewport: HTMLElement,
  onToolChange: (tool: Tool) => void,
): ToolManager {
  const byId = new Map<ToolId, Tool>(tools.map(t => [t.id, t]));
  let active = tools[0];

  const toolButtons = document.querySelectorAll<HTMLButtonElement>('.tool-btn');

  ctx.syncBrushRadius = () => {
    ctx.scene.brushRadius = active.brushRadius();
    // Bound per sync so a tool switch can't leave the old tool's shape behind.
    const shaped = active;
    ctx.scene.brushFootprint = shaped.hoverFootprint ? cell => shaped.hoverFootprint!(cell) : null;
  };
  ctx.updateCursor = () => {
    viewport.classList.toggle('is-filling', active.wantsFillCursor?.() ?? false);
  };

  function setActive(id: ToolId): void {
    const next = byId.get(id);
    if (!next) return;
    if (next !== active) active.deactivate();
    active = next;
    toolButtons.forEach(b => b.classList.toggle('active', b.dataset['tool'] === id));
    for (const t of tools) t.panel.classList.toggle('hidden', t !== active);
    ctx.scene.hoverMaskFeedback = !(active.ignoresSelectionMask ?? false);
    ctx.scene.hoverLockFeedback = !(active.ignoresLocks ?? false);
    ctx.syncBrushRadius();
    ctx.updateCursor();
    onToolChange(active);
  }

  toolButtons.forEach(btn => {
    btn.addEventListener('click', () => setActive(btn.dataset['tool'] as ToolId));
  });

  viewport.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    const cell = ctx.scene.hoveredCell;
    if (!cell) return;
    active.pointerDown(cell, e);
  });
  viewport.addEventListener('pointermove', e => {
    active.pointerMove(ctx.scene.hoveredCell, e);
  });
  // Leaving the viewport ends the hover — tools with hover previews (the
  // selection wand) need the null or their last preview lingers.
  viewport.addEventListener('pointerleave', e => {
    active.pointerMove(null, e);
  });
  viewport.addEventListener('pointerup',     () => active.pointerUp());
  viewport.addEventListener('pointercancel', () => active.pointerUp());
  viewport.addEventListener('dblclick',      () => active.doubleClick?.());

  // In the selection tool a STATIONARY right click acts as Alt+click
  // (subtract). A right-drag is the camera's rotate gesture, so the click is
  // resolved at pointer-up by how far the pointer travelled since the press.
  let rightPress: { x: number; y: number; cell: CellPos | null } | null = null;
  viewport.addEventListener('pointerdown', e => {
    if (e.button === 2 && active.id === 'select') {
      rightPress = { x: e.clientX, y: e.clientY, cell: ctx.scene.hoveredCell };
    }
  });
  viewport.addEventListener('pointerup', e => {
    if (e.button !== 2 || !rightPress) return;
    const press = rightPress;
    rightPress = null;
    if (active.id !== 'select' || !press.cell) return;
    if (Math.hypot(e.clientX - press.x, e.clientY - press.y) > 4) return;
    // Synthesised through the normal pointer path so every selection sub-tool
    // treats it exactly as an Alt+left-click (Shift+right = Shift+Alt).
    active.pointerDown(press.cell, new PointerEvent('pointerdown', { altKey: true, shiftKey: e.shiftKey }));
    active.pointerUp();
  });

  window.addEventListener('keydown', e => {
    if (e.key === 'Alt' && active.hasEyedropper) viewport.classList.add('is-eyedropping');
    // Don't fire shortcuts while the user is typing in an input/select
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
    if (active.keyDown?.(e)) return;
    if (!e.ctrlKey && !e.metaKey && !e.altKey && TOOL_HOTKEYS[e.key]) {
      setActive(TOOL_HOTKEYS[e.key]);
    }
  });
  window.addEventListener('keyup', e => {
    if (e.key === 'Alt') viewport.classList.remove('is-eyedropping');
  });

  // Sync button highlights, panel visibility, cursor, and brush radius once.
  setActive(active.id);

  return {
    get active() { return active; },
    setActive,
  };
}
