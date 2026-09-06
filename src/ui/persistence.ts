import { deserializeMap, serializeMapJSON, deserializeMapJSON, exportHexPack } from '@loyalj/hex-world';
import { encodeBits, decodeBits } from '../scene.ts';
import type { SceneApi } from '../scene.ts';
import type { CommandHistory } from '../undo/history.ts';
import type { PaletteApi } from './palette.ts';
import type { RostersApi } from './rosters.ts';
import type { ScatterBuilderApi } from './scatterBuilder.ts';
import type { EnvironmentTool, EnvironmentState } from '../tools/environmentTool.ts';
import type { FogTool, FogState } from '../tools/fogTool.ts';
import { clearSession, loadSession, storeSession } from './sessionStore.ts';

// The File System Access API (Chromium): real save-in-place. Optional — the
// declarations stay minimal and everything falls back to downloads / <input>.
interface FilePickerType { description?: string; accept: Record<string, string[]> }
declare global {
  interface Window {
    showSaveFilePicker?(opts?: { suggestedName?: string; types?: FilePickerType[] }): Promise<FileSystemFileHandle>;
    showOpenFilePicker?(opts?: { types?: FilePickerType[] }): Promise<FileSystemFileHandle[]>;
  }
}



/**
 * The editor-only block appended to the library's save JSON under the `editor`
 * key. The library serializer ignores unknown top-level keys, so this rides
 * along in the same file and old saves without it load fine.
 */
interface EditorSaveState {
  environment?: EnvironmentState;
  fog?:         FogState;
  /** Custom terrain texture images, asset id → data URL. */
  terrainImages?: Record<string, string>;
  /** Selection-mask bitmask, base64, row-major. Absent when nothing was selected. */
  selection?: string;
  /** Locked terrain indices. Absent when nothing was locked. */
  lockedTerrains?: number[];
}

/** Debounce after the last edit before the session is autosaved. */
const AUTOSAVE_DEBOUNCE_MS = 2500;

export interface PersistenceOptions {
  scene: SceneApi;
  history: CommandHistory;
  palette: PaletteApi;
  rosters: RostersApi;
  scatter: ScatterBuilderApi;
  environment: EnvironmentTool;
  fog: FogTool;
  /** Known generator plugin ids — load only adopts a generatorId it recognises. */
  pluginIds: string[];
  initialGeneratorId: string;
  initialSeed: number;
}

/**
 * Saving and loading in both formats (`.hexmap.json`, binary `.hxmp`), HexPack
 * export/import, and the document identity behind them — plus the safety net:
 * dirty tracking with a doc-strip asterisk and beforeunload guard, real
 * save-in-place where the File System Access API exists, environment/fog/
 * texture state embedded in saves, and a debounced IndexedDB autosave offered
 * back as "restore session" on the next launch.
 */
export interface PersistenceApi {
  /** Save to the current file (picker on first save). Bound to File ▸ Save and Ctrl+S. */
  save(): Promise<void>;
  /** Save under a new name/location. Bound to File ▸ Save as and Ctrl+Shift+S. */
  saveAs(): Promise<void>;
  /** Open the load picker (confirms first when there are unsaved changes). */
  openLoadPicker(): Promise<void>;
  /** Record a new unsaved document (wizard create, map replace). */
  markFresh(name: string): void;
  /** Record which generator/seed produced the current map (wizard create). */
  setGenerator(pluginId: string, seed: number): void;
  /** True to proceed: no unsaved changes, or the user agreed to lose them. */
  confirmDiscard(action: string): boolean;
  /** The history changed — refresh the doc strip and schedule an autosave. */
  noteMapChanged(): void;
  /** Non-history saved state changed (environment, fog, palette) — mark unsaved + autosave. */
  noteSettingsChanged(): void;
  /** Restore the autosaved session silently, if one exists. Call once at startup. */
  restoreSession(): Promise<void>;
}

export function initPersistence(opts: PersistenceOptions): PersistenceApi {
  const { scene, history, palette, rosters, scatter } = opts;

  const docName   = document.getElementById('doc-name')     as HTMLElement;
  const docSize   = document.getElementById('doc-size')     as HTMLElement;
  const saveBtn   = document.getElementById('save-btn')     as HTMLButtonElement;
  const saveAsBtn = document.getElementById('save-as-btn')  as HTMLButtonElement;
  const loadBtn   = document.getElementById('load-btn')     as HTMLButtonElement;
  const loadInput = document.getElementById('load-input')   as HTMLInputElement;
  const exportPackBtn = document.getElementById('export-pack-btn') as HTMLButtonElement;
  const openPackBtn   = document.getElementById('open-pack-btn')   as HTMLButtonElement;
  const openPackInput = document.getElementById('open-pack-input') as HTMLInputElement;

  let documentName = 'untitled';
  let generatorId  = opts.initialGeneratorId;
  let currentSeed  = opts.initialSeed;
  /** The open file, when it came through the File System Access API. */
  let fileHandle: FileSystemFileHandle | null = null;
  /**
   * History depth at the last save. −1 means "dirty regardless of depth" — a
   * restored session has an empty history but exists in no file.
   */
  let savedDepth = 0;
  /** Saved-file state outside the history changed: environment, fog, palette. */
  let settingsDirty = false;
  let autosaveTimer: number | null = null;

  // documentDepth, not depth: transient commands (selection gestures) share
  // the undo stack but aren't saved-file state, so they must not read as
  // unsaved changes.
  const isDirty = (): boolean => settingsDirty || history.documentDepth !== savedDepth;

  function refreshDocStrip(): void {
    docName.textContent = isDirty() ? `${documentName} *` : documentName;
    docSize.textContent = `${scene.map.width} × ${scene.map.height}`;
  }

  function confirmDiscard(action: string): boolean {
    return !isDirty() || confirm(`You have unsaved changes — ${action} anyway?`);
  }

  /** Everything a save/autosave records is now on disk (or exported). */
  function markSavedNow(): void {
    savedDepth    = history.documentDepth;
    settingsDirty = false;
    refreshDocStrip();
    void clearSession();
  }

  function markFresh(name: string, keepSession = false): void {
    documentName  = name;
    savedDepth    = history.documentDepth;
    settingsDirty = false;
    fileHandle    = null;
    refreshDocStrip();
    // A fresh document supersedes the autosaved session — except when the
    // fresh document IS the restored session, which must survive until the
    // first new autosave in case this launch also ends abruptly.
    if (!keepSession) void clearSession();
  }

  const cleanName = (filename: string): string =>
    filename.replace(/\.(hxmp|hexmap\.json|json)$/i, '');

  // ---- Save format ----

  /** The library's JSON with the editor block appended. */
  async function buildSaveJSON(): Promise<string> {
    const json = serializeMapJSON(scene.map, { generatorId, seed: currentSeed }, {
      scatterDescriptors:  scatter.descriptors,
      scatterAssets:       scatter.assets,
      terrainDescriptors:  palette.terrains,
      liquidDescriptors:   palette.liquids,
      resourceDescriptors: rosters.resourceTypes,
      factions:            rosters.factions,
    });
    const payload = JSON.parse(json) as Record<string, unknown>;
    const editor: EditorSaveState = {
      environment:   opts.environment.snapshot(),
      fog:           opts.fog.snapshot(),
      terrainImages: await palette.textureAssetsAsDataURLs(),
    };
    if (scene.selection.size > 0) {
      const { width, height } = scene.map;
      editor.selection = encodeBits(width * height,
        i => scene.selection.has(i % width, Math.floor(i / width)));
    }
    if (scene.locks.size > 0) editor.lockedTerrains = scene.locks.indices();
    payload['editor'] = editor;
    return JSON.stringify(payload);
  }

  async function applyLoadedJSON(text: string, name: string, fromSession = false): Promise<void> {
    const result = deserializeMapJSON(text);
    if (result.metadata.seed !== undefined) currentSeed = result.metadata.seed;
    if (result.metadata.generatorId && opts.pluginIds.includes(result.metadata.generatorId)) {
      generatorId = result.metadata.generatorId;
    }
    let editor: EditorSaveState | undefined;
    try {
      editor = (JSON.parse(text) as { editor?: EditorSaveState }).editor;
    } catch { /* unreachable: deserializeMapJSON already parsed it */ }

    await palette.applyLoadedDescriptors(
      result.terrainDescriptors, result.liquidDescriptors, editor?.terrainImages);
    rosters.applyLoaded(result.factions, result.resourceDescriptors);
    scatter.applyLoaded(result.scatterAssets, result.scatterDescriptors);
    scene.replaceMap(result.map);
    history.clear();
    // The editor block is best-effort: a hand-edited or older file must still
    // load its map even if the environment/fog entries don't apply cleanly.
    try {
      if (editor?.environment) opts.environment.restore(editor.environment);
      if (editor?.fog)         opts.fog.restore(editor.fog);
      if (editor?.selection) {
        // After replaceMap (which cleared any old selection) and history.clear
        // — setCells stays outside the undo stream, so the loaded document
        // doesn't open with a phantom undo entry.
        const { width, height } = scene.map;
        const cells: Array<{ col: number; row: number }> = [];
        decodeBits(editor.selection, width * height,
          i => cells.push({ col: i % width, row: Math.floor(i / width) }));
        scene.selection.setCells(cells);
      }
      // After replaceMap, which reset the locks along with the selection.
      if (editor?.lockedTerrains?.length) scene.locks.setIndices(editor.lockedTerrains);
    } catch (err) {
      console.warn('Save file editor state not fully restored:', err);
    }
    markFresh(name, fromSession);
    if (fromSession) {
      savedDepth = -1; // restored work lives in no file yet
      refreshDocStrip();
    }
  }

  // ---- Save ----

  async function writeTo(handle: FileSystemFileHandle, text: string): Promise<void> {
    const writable = await handle.createWritable();
    await writable.write(text);
    await writable.close();
  }

  /** Hand the browser a generated file as a download. */
  function download(blob: Blob, filename: string): void {
    const url = URL.createObjectURL(blob);
    const a   = document.createElement('a');
    a.href     = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function saveAs(): Promise<void> {
    const text = await buildSaveJSON();
    if (window.showSaveFilePicker) {
      let handle: FileSystemFileHandle;
      try {
        handle = await window.showSaveFilePicker({
          suggestedName: `${documentName}.hexmap.json`,
          types: [{ description: 'Hex map (JSON)', accept: { 'application/json': ['.json'] } }],
        });
      } catch {
        return; // picker cancelled
      }
      await writeTo(handle, text);
      fileHandle   = handle;
      documentName = cleanName(handle.name);
    } else {
      download(new Blob([text], { type: 'application/json' }), `${documentName}.hexmap.json`);
    }
    markSavedNow();
  }

  async function save(): Promise<void> {
    if (fileHandle) {
      try {
        await writeTo(fileHandle, await buildSaveJSON());
        markSavedNow();
        return;
      } catch {
        // Permission revoked or the file is gone — fall through to the picker.
        fileHandle = null;
      }
    }
    await saveAs();
  }

  saveBtn.addEventListener('click', () => void save());
  saveAsBtn.addEventListener('click', () => void saveAs());

  // ---- Load ----

  /** Returns true when the file was applied. */
  async function loadFile(file: File): Promise<boolean> {
    try {
      if (file.name.endsWith('.json')) {
        await applyLoadedJSON(await file.text(), cleanName(file.name));
      } else {
        const loaded = deserializeMap(new Uint8Array(await file.arrayBuffer()));
        scene.replaceMap(loaded);
        history.clear();
        markFresh(cleanName(file.name));
      }
      return true;
    } catch (err) {
      alert(`Failed to load map: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  async function openLoadPicker(): Promise<void> {
    if (!confirmDiscard('load a map')) return;
    if (window.showOpenFilePicker) {
      let handles: FileSystemFileHandle[];
      try {
        handles = await window.showOpenFilePicker({
          types: [{
            description: 'Hex maps',
            accept: { 'application/json': ['.json'], 'application/octet-stream': ['.hxmp'] },
          }],
        });
      } catch {
        return; // picker cancelled
      }
      const handle = handles[0];
      if (!handle) return;
      const file = await handle.getFile();
      if (await loadFile(file) && file.name.endsWith('.json')) {
        // Keep the handle so Ctrl+S writes straight back to this file — but
        // never for .hxmp, where saving would overwrite binary with JSON.
        fileHandle = handle;
      }
    } else {
      loadInput.click();
    }
  }

  loadBtn.addEventListener('click', () => void openLoadPicker());
  loadInput.addEventListener('change', async () => {
    const file = loadInput.files?.[0];
    if (!file) return;
    loadInput.value = '';
    await loadFile(file);
  });

  // ---- Export / Import HexPack ----
  exportPackBtn.addEventListener('click', async () => {
    const blob = await exportHexPack({
      name:                'Map Pack',
      terrainDescriptors:  palette.terrains,
      liquidDescriptors:   palette.liquids,
      scatterDescriptors:  scatter.descriptors,
      scatterAssets:       scatter.assets,
      resourceDescriptors: rosters.resourceTypes,
      factions:            rosters.factions,
      textureAssets:       palette.textureAssets,
      maps: [{
        id:       'map-1',
        name:     'My Map',
        map:      scene.map,
        metadata: { generatorId, seed: currentSeed },
        format:   'json',
      }],
    });
    download(blob, `${documentName}.hexpack`);
    // A pack embeds everything the JSON save does except environment/fog —
    // still counts as saved: the user chose the export format deliberately.
    markSavedNow();
  });

  openPackBtn.addEventListener('click', () => {
    if (!confirmDiscard('open a pack')) return;
    openPackInput.click();
  });
  openPackInput.addEventListener('change', async () => {
    const file = openPackInput.files?.[0];
    if (!file) return;
    openPackInput.value = '';
    try {
      const { terrainDescriptors, liquidDescriptors, factions, resourceDescriptors, scatterAssets, scatterDescriptors, maps } =
        await scene.loadAndApplyHexPack(file);
      palette.adoptPackDescriptors(terrainDescriptors, liquidDescriptors);
      rosters.applyLoaded(factions, resourceDescriptors);
      scatter.applyLoaded(scatterAssets, scatterDescriptors);
      if (maps.size > 0) {
        scene.replaceMap([...maps.values()][0]);
        history.clear();
        markFresh(cleanName(file.name.replace(/\.hexpack$/i, '')));
      }
    } catch (err) {
      alert(`Failed to load pack: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  // ---- Autosave ----

  async function autosaveNow(): Promise<void> {
    if (!isDirty()) return;
    await storeSession({ name: documentName, json: await buildSaveJSON(), savedAt: Date.now() });
  }

  function scheduleAutosave(): void {
    if (autosaveTimer !== null) clearTimeout(autosaveTimer);
    autosaveTimer = window.setTimeout(() => {
      autosaveTimer = null;
      void autosaveNow();
    }, AUTOSAVE_DEBOUNCE_MS);
  }

  function noteMapChanged(): void {
    refreshDocStrip();
    scheduleAutosave();
  }

  function noteSettingsChanged(): void {
    settingsDirty = true;
    refreshDocStrip();
    scheduleAutosave();
  }

  async function restoreSession(): Promise<void> {
    const session = await loadSession();
    if (!session) return;
    // No confirm prompt: the autosave is the user's own latest work, and the
    // fresh generated map it replaces cost nothing. Restoring silently makes
    // launch feel like picking up where they left off.
    try {
      await applyLoadedJSON(session.json, session.name, true);
    } catch (err) {
      alert(`Failed to restore the session: ${err instanceof Error ? err.message : String(err)}`);
      void clearSession();
    }
  }

  // ---- Unload guard ----
  window.addEventListener('beforeunload', e => {
    if (!isDirty()) return;
    e.preventDefault();
    // Chrome requires returnValue to show the dialog at all.
    (e as BeforeUnloadEvent).returnValue = '';
  });

  refreshDocStrip();

  return {
    save,
    saveAs,
    openLoadPicker,
    markFresh: (name: string) => markFresh(name),
    setGenerator(pluginId: string, seed: number): void {
      if (opts.pluginIds.includes(pluginId)) generatorId = pluginId;
      currentSeed = seed;
    },
    confirmDiscard,
    noteMapChanged,
    noteSettingsChanged,
    restoreSession,
  };
}
