// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';
import { initPersistence } from '../src/ui/persistence.ts';
import type { PersistenceApi } from '../src/ui/persistence.ts';
import type { PaletteApi } from '../src/ui/palette.ts';
import type { RostersApi } from '../src/ui/rosters.ts';
import type { EnvironmentTool } from '../src/tools/environmentTool.ts';
import type { FogTool } from '../src/tools/fogTool.ts';
import type { SceneApi } from '../src/scene.ts';
import { CommandHistory } from '../src/undo/history.ts';
import { loadEditorDom, makeScene } from './helpers.ts';
import type { FakeScene } from './helpers.ts';
import { clearSession, loadSession, storeSession } from '../src/ui/sessionStore.ts';

vi.mock('../src/ui/sessionStore.ts', () => ({
  loadSession:  vi.fn(async () => null),
  storeSession: vi.fn(async () => {}),
  clearSession: vi.fn(async () => {}),
}));

const ENV_STATE = { tod: 720, weather: 'rain' };
const FOG_STATE = { enabled: true, hideUnexplored: true, dimExplored: false, explored: 'QUJD' };
const IMAGES    = { 'terrain-img-9': 'data:image/png;base64,AAAA' };

let s: FakeScene;
let history: CommandHistory;
let p: PersistenceApi;
let envRestore: Mock;
let fogRestore: Mock;
let paletteApply: Mock;
let rostersApply: Mock;

const edit = { execute() {}, undo() {} };
const docText = () => document.getElementById('doc-name')!.textContent;

beforeEach(() => {
  loadEditorDom();
  s = makeScene();
  history = new CommandHistory();
  envRestore   = vi.fn();
  fogRestore   = vi.fn();
  paletteApply = vi.fn(async () => {});
  rostersApply = vi.fn();
  const palette = {
    terrains: [], liquids: [], textureAssets: new Map<string, Blob>(),
    textureAssetsAsDataURLs: async () => IMAGES,
    applyLoadedDescriptors: paletteApply,
    adoptPackDescriptors: vi.fn(),
    openTerrainDialog() {}, openLiquidDialog() {},
  } as unknown as PaletteApi;
  const rosters = {
    factions: [{ id: 'red', name: 'Red', color: 0xff0000 }],
    resourceTypes: [{ id: 'ore', name: 'Ore', color: 0x888888 }],
    applyLoaded: rostersApply,
    openFactionDialog() {}, openResourceDialog() {},
  } as unknown as RostersApi;
  p = initPersistence({
    scene: s as unknown as SceneApi,
    history,
    palette,
    rosters,
    environment: { snapshot: () => ENV_STATE, restore: envRestore } as unknown as EnvironmentTool,
    fog:         { snapshot: () => FOG_STATE, restore: fogRestore } as unknown as FogTool,
    pluginIds: ['fbm'],
    initialGeneratorId: 'fbm',
    initialSeed: 42,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.clearAllMocks();
});

/** Make the document dirty via one committed edit. */
function dirty(): void {
  history.commit(edit);
  p.noteMapChanged();
}

/** Stub the save picker, run a save, and hand back what was written. */
async function saveVia(handleName: string): Promise<{ written: () => string; picker: Mock }> {
  let text = '';
  const handle = {
    name: handleName,
    createWritable: async () => ({
      write: async (t: string) => { text = t; },
      close: async () => {},
    }),
  };
  const picker = vi.fn(async () => handle);
  vi.stubGlobal('showSaveFilePicker', picker);
  await p.save();
  return { written: () => text, picker };
}

describe('dirty tracking', () => {
  // First in the file: every test's persistence instance leaves a beforeunload
  // listener on the shared window, and any earlier dirtied history would keep
  // vetoing the "clean" dispatch below.
  it('guards beforeunload only while dirty', () => {
    const clean = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(clean);
    expect(clean.defaultPrevented).toBe(false);

    dirty();
    const guarded = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(guarded);
    expect(guarded.defaultPrevented).toBe(true);
  });

  it('shows an asterisk once the history moves and clears it on save', async () => {
    expect(docText()).toBe('untitled');
    dirty();
    expect(docText()).toBe('untitled *');
    await saveVia('seaside.hexmap.json');
    expect(docText()).toBe('seaside'); // renamed to the picked file, no asterisk
  });

  it('confirmDiscard passes silently when clean, asks when dirty', () => {
    const confirm = vi.fn(() => false);
    vi.stubGlobal('confirm', confirm);
    expect(p.confirmDiscard('test')).toBe(true);
    expect(confirm).not.toHaveBeenCalled();
    dirty();
    expect(p.confirmDiscard('test')).toBe(false);
    expect(confirm).toHaveBeenCalledOnce();
  });

});

describe('save', () => {
  it('embeds the editor block and reuses the file handle on later saves', async () => {
    dirty();
    const { written, picker } = await saveVia('seaside.hexmap.json');
    const payload = JSON.parse(written()) as {
      editor?: Record<string, unknown>; generatorId?: string;
      factions?: unknown; resourceDescriptors?: unknown;
    };
    expect(payload.editor).toEqual({
      environment: ENV_STATE,
      fog: FOG_STATE,
      terrainImages: IMAGES,
    });
    expect(payload.generatorId).toBe('fbm');
    expect(payload.factions).toEqual([{ id: 'red', name: 'Red', color: 0xff0000 }]);
    expect(payload.resourceDescriptors).toEqual([{ id: 'ore', name: 'Ore', color: 0x888888 }]);
    expect(clearSession).toHaveBeenCalled(); // saved work needs no session

    dirty();
    await p.save(); // same handle — no second picker
    expect(picker).toHaveBeenCalledOnce();
    expect(docText()).toBe('seaside');
  });
});

describe('load', () => {
  it('round-trips map data and editor state through the open picker', async () => {
    s.map.setTerrain(2, 2, 4);
    s.map.setElevation(2, 2, 7);
    dirty();
    const { written } = await saveVia('isle.hexmap.json');

    // Wreck the live map, then load the save back.
    s.map.setTerrain(2, 2, 0);
    s.map.setElevation(2, 2, 0);
    dirty();
    vi.stubGlobal('confirm', vi.fn(() => true));
    const openHandle = {
      name: 'isle.hexmap.json',
      getFile: async () => new File([written()], 'isle.hexmap.json', { type: 'application/json' }),
    };
    vi.stubGlobal('showOpenFilePicker', vi.fn(async () => [openHandle]));
    await p.openLoadPicker();

    expect(s.map.getTerrain(2, 2)).toBe(4);
    expect(s.map.getElevation(2, 2)).toBe(7);
    expect(paletteApply).toHaveBeenCalledWith([], [], IMAGES);
    // The rosters saved above come back through the load.
    expect(rostersApply).toHaveBeenCalledWith(
      [{ id: 'red', name: 'Red', color: 0xff0000 }],
      [{ id: 'ore', name: 'Ore', color: 0x888888 }],
    );
    expect(envRestore).toHaveBeenCalledWith(ENV_STATE);
    expect(fogRestore).toHaveBeenCalledWith(FOG_STATE);
    expect(docText()).toBe('isle');
  });

  it('a dirty document blocks the picker when the user declines', async () => {
    dirty();
    vi.stubGlobal('confirm', vi.fn(() => false));
    const picker = vi.fn(async () => []);
    vi.stubGlobal('showOpenFilePicker', picker);
    await p.openLoadPicker();
    expect(picker).not.toHaveBeenCalled();
  });
});

describe('autosave', () => {
  it('stores the session after the debounce, only when dirty', async () => {
    vi.useFakeTimers();
    p.noteMapChanged(); // strip refresh while clean — no session write
    await vi.advanceTimersByTimeAsync(5000);
    expect(storeSession).not.toHaveBeenCalled();

    dirty();
    await vi.advanceTimersByTimeAsync(5000);
    expect(storeSession).toHaveBeenCalledOnce();
    const stored = (storeSession as Mock).mock.calls[0][0] as { name: string; json: string };
    expect(stored.name).toBe('untitled');
    expect(JSON.parse(stored.json)).toHaveProperty('editor');
  });
});

describe('settings changes', () => {
  it('dirty the document and autosave without any history edit', async () => {
    vi.useFakeTimers();
    expect(docText()).toBe('untitled');
    p.noteSettingsChanged();
    expect(docText()).toBe('untitled *');
    await vi.advanceTimersByTimeAsync(5000);
    expect(storeSession).toHaveBeenCalledOnce();
  });

  it('are cleared by a save like history edits', async () => {
    p.noteSettingsChanged();
    await saveVia('tweaked.hexmap.json');
    expect(docText()).toBe('tweaked');
  });
});

describe('selection persistence', () => {
  it('round-trips the selection mask through save and load, outside the undo stream', async () => {
    s.selection.apply([{ col: 1, row: 1 }, { col: 5, row: 3 }], 'replace');
    const { written } = await saveVia('sel.hexmap.json');
    const editor = (JSON.parse(written()) as { editor: { selection?: string } }).editor;
    expect(editor.selection).toBeTruthy();

    s.selection.clear();
    let commits = 0;
    s.selection.onCommit = () => commits++;
    (loadSession as Mock).mockResolvedValueOnce({ name: 'sel', json: written(), savedAt: Date.now() });
    await p.restoreSession();
    expect(s.selection.size).toBe(2);
    expect(s.selection.has(1, 1)).toBe(true);
    expect(s.selection.has(5, 3)).toBe(true);
    // A restore is not a gesture — no phantom undo entry for the loaded mask.
    expect(commits).toBe(0);
  });

  it('omits the selection block when nothing is selected', async () => {
    const { written } = await saveVia('empty.hexmap.json');
    const editor = (JSON.parse(written()) as { editor: { selection?: string } }).editor;
    expect(editor.selection).toBeUndefined();
  });
});

describe('lock persistence', () => {
  it('round-trips locked terrains through save and restore', async () => {
    s.locks.setIndices([7, 2]);
    const { written } = await saveVia('locked.hexmap.json');
    const editor = (JSON.parse(written()) as { editor: { lockedTerrains?: number[] } }).editor;
    expect(editor.lockedTerrains).toEqual([2, 7]);

    s.locks.setIndices([]);
    (loadSession as Mock).mockResolvedValueOnce({ name: 'locked', json: written(), savedAt: Date.now() });
    await p.restoreSession();
    expect(s.locks.indices()).toEqual([2, 7]);
  });

  it('omits the block when nothing is locked', async () => {
    const { written } = await saveVia('unlocked.hexmap.json');
    const editor = (JSON.parse(written()) as { editor: { lockedTerrains?: number[] } }).editor;
    expect(editor.lockedTerrains).toBeUndefined();
  });
});

describe('session restore', () => {
  it('restores the stored session silently and marks it unsaved', async () => {
    dirty();
    const { written } = await saveVia('camp.hexmap.json');
    (loadSession as Mock).mockResolvedValueOnce({ name: 'camp', json: written(), savedAt: Date.now() });
    const confirmSpy = vi.fn(() => true);
    vi.stubGlobal('confirm', confirmSpy);

    await p.restoreSession();
    // No prompt: the autosave is the user's own latest work — just load it.
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(envRestore).toHaveBeenCalledWith(ENV_STATE);
    // Restored work exists in no file — dirty even with an empty history.
    expect(docText()).toBe('camp *');
    // And the stored session survives until the next save or autosave.
    expect((clearSession as Mock).mock.calls.length).toBe(1); // only the earlier saveVia
  });

  it('clears the stored session when restoring it fails', async () => {
    (loadSession as Mock).mockResolvedValueOnce({ name: 'camp', json: '{not json', savedAt: Date.now() });
    vi.stubGlobal('alert', vi.fn());
    await p.restoreSession();
    expect(clearSession).toHaveBeenCalled();
    expect(docText()).toBe('untitled');
  });
});
