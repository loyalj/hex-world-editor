// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { initToolManager } from '../src/tools/toolManager.ts';
import type { Tool, ToolContext, ToolId } from '../src/tools/tool.ts';
import { loadEditorDom, makeCtx, makeScene } from './helpers.ts';
import type { FakeScene } from './helpers.ts';

let s: FakeScene;
let ctx: ToolContext;

function stub(id: ToolId, panelId: string, over: Partial<Tool> = {}): Tool {
  return {
    id,
    title: id,
    panel: document.getElementById(panelId) as HTMLElement,
    brushRadius: () => 2,
    deactivate: vi.fn(),
    pointerDown: vi.fn(),
    pointerMove: vi.fn(),
    pointerUp: vi.fn(),
    statusText: () => id,
    ...over,
  };
}

beforeEach(() => {
  loadEditorDom();
  s = makeScene();
  ctx = makeCtx(s).ctx;
});

describe('initToolManager', () => {
  it('activates the first tool: panel shown, brush radius synced', () => {
    const a = stub('paint-terrain', 'terrain-options');
    const b = stub('elevation', 'elevation-options');
    const changes: string[] = [];
    const mgr = initToolManager(ctx, [a, b], document.getElementById('viewport')!, t => changes.push(t.id));

    expect(mgr.active).toBe(a);
    expect(a.panel.classList.contains('hidden')).toBe(false);
    expect(b.panel.classList.contains('hidden')).toBe(true);
    expect(s.brushRadius).toBe(2);
    expect(changes).toEqual(['paint-terrain']);
  });

  it('number hotkeys switch tools and deactivate the old one', () => {
    const a = stub('paint-terrain', 'terrain-options');
    const b = stub('elevation', 'elevation-options');
    const mgr = initToolManager(ctx, [a, b], document.getElementById('viewport')!, () => {});

    window.dispatchEvent(new KeyboardEvent('keydown', { key: '2' }));
    expect(mgr.active).toBe(b);
    expect(a.deactivate).toHaveBeenCalled();
    expect(a.panel.classList.contains('hidden')).toBe(true);
    expect(b.panel.classList.contains('hidden')).toBe(false);
  });

  it('routes viewport pointer events to the active tool, only with a hovered cell', () => {
    const a = stub('paint-terrain', 'terrain-options');
    const viewport = document.getElementById('viewport')!;
    initToolManager(ctx, [a], viewport, () => {});

    viewport.dispatchEvent(new MouseEvent('pointerdown', { button: 0 }));
    expect(a.pointerDown).not.toHaveBeenCalled(); // no hovered cell

    s.hoveredCell = { col: 3, row: 4 };
    viewport.dispatchEvent(new MouseEvent('pointerdown', { button: 0 }));
    expect(a.pointerDown).toHaveBeenCalledWith({ col: 3, row: 4 }, expect.anything());

    viewport.dispatchEvent(new MouseEvent('pointerdown', { button: 2 }));
    expect(a.pointerDown).toHaveBeenCalledTimes(1); // right button ignored

    viewport.dispatchEvent(new MouseEvent('pointerup'));
    expect(a.pointerUp).toHaveBeenCalled();
  });

  it('a stationary right click reaches a tool that handles one', () => {
    const rightClick = vi.fn();
    const a = stub('select', 'selection-options', { rightClick });
    const viewport = document.getElementById('viewport')!;
    initToolManager(ctx, [a], viewport, () => {});
    s.hoveredCell = { col: 3, row: 4 };

    viewport.dispatchEvent(new MouseEvent('pointerdown', { button: 2, clientX: 100, clientY: 100 }));
    viewport.dispatchEvent(new MouseEvent('pointerup',   { button: 2, clientX: 101, clientY: 101 }));
    expect(rightClick).toHaveBeenCalledWith({ col: 3, row: 4 }, expect.anything());
    expect(a.pointerDown).not.toHaveBeenCalled();
  });

  it('a right DRAG stays the camera gesture — no right click', () => {
    const rightClick = vi.fn();
    const a = stub('select', 'selection-options', { rightClick });
    const viewport = document.getElementById('viewport')!;
    initToolManager(ctx, [a], viewport, () => {});
    s.hoveredCell = { col: 3, row: 4 };

    viewport.dispatchEvent(new MouseEvent('pointerdown', { button: 2, clientX: 100, clientY: 100 }));
    viewport.dispatchEvent(new MouseEvent('pointerup',   { button: 2, clientX: 160, clientY: 100 }));
    expect(rightClick).not.toHaveBeenCalled();
  });

  it('right click on a tool without a handler stays inert', () => {
    const a = stub('paint-terrain', 'terrain-options');
    const viewport = document.getElementById('viewport')!;
    initToolManager(ctx, [a], viewport, () => {});
    s.hoveredCell = { col: 3, row: 4 };

    viewport.dispatchEvent(new MouseEvent('pointerdown', { button: 2, clientX: 100, clientY: 100 }));
    viewport.dispatchEvent(new MouseEvent('pointerup',   { button: 2, clientX: 100, clientY: 100 }));
    expect(a.pointerDown).not.toHaveBeenCalled();
  });

  it('activating a tool calls its activate hook', () => {
    const activate = vi.fn();
    const a = stub('select', 'selection-options');
    const b = stub('paint-terrain', 'terrain-options', { activate });
    initToolManager(ctx, [a, b], document.getElementById('viewport')!, () => {});
    expect(activate).not.toHaveBeenCalled();
    (document.querySelector('.tool-btn[data-tool="paint-terrain"]') as HTMLButtonElement).click();
    expect(activate).toHaveBeenCalledTimes(1);
  });

  it('gives the active tool first refusal on keys', () => {
    const keyDown = vi.fn(() => true);
    const a = stub('paint-terrain', 'terrain-options', { keyDown });
    const b = stub('elevation', 'elevation-options');
    const mgr = initToolManager(ctx, [a, b], document.getElementById('viewport')!, () => {});

    window.dispatchEvent(new KeyboardEvent('keydown', { key: '2' }));
    expect(keyDown).toHaveBeenCalled();
    expect(mgr.active).toBe(a); // consumed — the hotkey never fired
  });

  it('ignores hotkeys while typing in an input', () => {
    const a = stub('paint-terrain', 'terrain-options');
    const b = stub('elevation', 'elevation-options');
    const mgr = initToolManager(ctx, [a, b], document.getElementById('viewport')!, () => {});

    const input = document.createElement('input');
    document.body.appendChild(input);
    input.dispatchEvent(new KeyboardEvent('keydown', { key: '2', bubbles: true }));
    expect(mgr.active).toBe(a);
  });

  it('shows the eyedropper cursor only for tools that sample', () => {
    const a = stub('paint-terrain', 'terrain-options', { hasEyedropper: true });
    const b = stub('elevation', 'elevation-options');
    const viewport = document.getElementById('viewport')!;
    initToolManager(ctx, [a, b], viewport, () => {});

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Alt' }));
    expect(viewport.classList.contains('is-eyedropping')).toBe(true);
    window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Alt' }));
    expect(viewport.classList.contains('is-eyedropping')).toBe(false);

    window.dispatchEvent(new KeyboardEvent('keydown', { key: '2' })); // b has no eyedropper
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Alt' }));
    expect(viewport.classList.contains('is-eyedropping')).toBe(false);
  });

  it('hover mask feedback follows the active tool', () => {
    const a = stub('select', 'selection-options', { ignoresSelectionMask: true });
    const b = stub('paint-terrain', 'terrain-options');
    initToolManager(ctx, [a, b], document.getElementById('viewport')!, () => {});

    expect(s.hoverMaskFeedback).toBe(false); // the selection tool is exempt
    window.dispatchEvent(new KeyboardEvent('keydown', { key: '1' }));
    expect(s.hoverMaskFeedback).toBe(true);  // paint tools are confined
  });

  it('fill-cursor class follows the active tool', () => {
    const a = stub('paint-terrain', 'terrain-options', { wantsFillCursor: () => true });
    const b = stub('elevation', 'elevation-options');
    const viewport = document.getElementById('viewport')!;
    initToolManager(ctx, [a, b], viewport, () => {});

    expect(viewport.classList.contains('is-filling')).toBe(true);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: '2' }));
    expect(viewport.classList.contains('is-filling')).toBe(false);
  });
});
