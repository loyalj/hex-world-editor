import type { SceneApi, CameraMode } from '../scene.ts';
import { loadUiPref, storeUiPref } from './uiPrefs.ts';

export interface MenusOptions {
  scene: SceneApi;
  minimapInvalidate(): void;
  /** A chrome panel was shown or hidden — panels that skip work while hidden catch up here. */
  onPanelToggle?(panel: PanelId, visible: boolean): void;
}

/** The chrome panels View ▸ Panels shows and hides. */
export type PanelId = 'drawer' | 'minimap' | 'inspector' | 'locks' | 'terrains' | 'holdings' | 'resources';

export interface MenusApi {
  /** Show or hide a chrome panel, syncing its menu check and stored pref. */
  setPanelVisible(panel: PanelId, visible: boolean): void;
}

/**
 * The menu bar's dropdown behaviour, the View menu's scene toggles (grid,
 * shadows, sky, god rays, skirt, camera mode, overlays), and the View ▸ Panels
 * chrome visibility (tool drawer plus the right-column panels, persisted as a
 * per-browser preference). File-menu entries wire themselves elsewhere:
 * save/load in persistence, terrain/liquid dialogs in the palette, New Map in
 * main.
 */
export function initMenus(opts: MenusOptions): MenusApi {
  const { scene } = opts;

  // ---- Menu bar ----
  // Each .menu-dropdown pairs a .menu-btn with the .menu-panel beside it; opening
  // one closes the rest, and any click elsewhere closes all of them.
  const menus = [...document.querySelectorAll<HTMLElement>('.menu-dropdown')].map(root => ({
    btn:   root.querySelector<HTMLButtonElement>('.menu-btn')!,
    panel: root.querySelector<HTMLElement>('.menu-panel')!,
  }));

  function closeMenus(): void {
    for (const m of menus) {
      m.panel.classList.add('hidden');
      m.btn.classList.remove('is-open');
    }
  }

  for (const menu of menus) {
    menu.btn.addEventListener('click', e => {
      e.stopPropagation();
      const wasOpen = !menu.panel.classList.contains('hidden');
      closeMenus();
      if (!wasOpen) {
        menu.panel.classList.remove('hidden');
        menu.btn.classList.add('is-open');
      }
    });
    // Hovering across the bar with a menu already open switches to that menu.
    menu.btn.addEventListener('pointerenter', () => {
      if (menus.some(m => !m.panel.classList.contains('hidden'))) {
        closeMenus();
        menu.panel.classList.remove('hidden');
        menu.btn.classList.add('is-open');
      }
    });
  }
  document.addEventListener('click', closeMenus);

  // ---- View ▸ Panels: chrome visibility ----
  // User preferences — the menu toggles flip them, tool switches don't. The
  // convention: the left drawer is the active tool's home; the right column is
  // tool-independent surfaces (navigation, readout, global modifiers).
  const rightPanel = document.getElementById('right-panel') as HTMLElement;
  const PANELS: Record<PanelId, { el: HTMLElement; check: HTMLElement; btn: HTMLElement; def: boolean }> = {
    drawer: {
      el:    document.getElementById('left-panel')!,
      check: document.getElementById('drawer-check')!,
      btn:   document.getElementById('toggle-drawer-menu-btn')!,
      def:   true,
    },
    minimap: {
      el:    document.getElementById('minimap-panel')!,
      check: document.getElementById('minimap-check')!,
      btn:   document.getElementById('toggle-minimap-btn')!,
      def:   true,
    },
    inspector: {
      el:    document.getElementById('inspector-panel')!,
      check: document.getElementById('inspector-check')!,
      btn:   document.getElementById('toggle-inspector-btn')!,
      def:   true,
    },
    // Off until wanted — the status-strip chip surfaces active locks anyway.
    locks: {
      el:    document.getElementById('locks-panel')!,
      check: document.getElementById('locks-check')!,
      btn:   document.getElementById('toggle-locks-btn')!,
      def:   false,
    },
    terrains: {
      el:    document.getElementById('terrains-panel')!,
      check: document.getElementById('terrains-check')!,
      btn:   document.getElementById('toggle-terrains-btn')!,
      def:   false,
    },
    holdings: {
      el:    document.getElementById('holdings-panel')!,
      check: document.getElementById('holdings-check')!,
      btn:   document.getElementById('toggle-holdings-btn')!,
      def:   false,
    },
    resources: {
      el:    document.getElementById('resource-stats-panel')!,
      check: document.getElementById('resource-stats-check')!,
      btn:   document.getElementById('toggle-resource-stats-btn')!,
      def:   false,
    },
  };
  const panelOpen = {} as Record<PanelId, boolean>;

  function setPanelVisible(id: PanelId, visible: boolean): void {
    panelOpen[id] = visible;
    const p = PANELS[id];
    p.el.classList.toggle('hidden', !visible);
    p.check.classList.toggle('hidden', !visible);
    storeUiPref(`panel:${id}`, visible);
    // With every right-column panel off, the empty column gives its width back.
    rightPanel.classList.toggle('hidden',
      !panelOpen.minimap && !panelOpen.inspector && !panelOpen.locks
      && !panelOpen.terrains && !panelOpen.holdings && !panelOpen.resources);
    opts.onPanelToggle?.(id, visible);
  }

  for (const id of Object.keys(PANELS) as PanelId[]) {
    PANELS[id].btn.addEventListener('click', () => setPanelVisible(id, !panelOpen[id]));
    setPanelVisible(id, loadUiPref(`panel:${id}`) ?? PANELS[id].def);
  }

  // ---- View toggles ----
  /** A View-menu checkmark toggle driving one boolean scene setting. */
  function wireToggle(btnId: string, checkId: string, initial: boolean, apply: (on: boolean) => void): void {
    let on = initial;
    const check = document.getElementById(checkId) as HTMLElement;
    (document.getElementById(btnId) as HTMLButtonElement).addEventListener('click', () => {
      on = !on;
      apply(on);
      check.classList.toggle('hidden', !on);
    });
  }

  wireToggle('toggle-grid-btn',     'grid-check',     false, on => scene.setHexGrid(on));
  wireToggle('toggle-heatmap-btn',  'heatmap-check',  false, on => scene.setElevationHeatmap(on));
  wireToggle('toggle-contours-btn', 'contours-check', false, on => scene.setContourLines(on));
  wireToggle('toggle-riverflow-btn', 'riverflow-check', false, on => scene.setRiverFlowOverlay(on));
  wireToggle('toggle-basins-btn',    'basins-check',    false, on => scene.setDrainageBasins(on));
  wireToggle('toggle-roadnets-btn',  'roadnets-check',  false, on => scene.setRoadNetworks(on));
  wireToggle('toggle-shadows-btn', 'shadows-check', true,  on => scene.setShadows(on));
  wireToggle('toggle-sky-btn',     'sky-check',     true,  on => scene.setSky(on));
  wireToggle('toggle-godrays-btn', 'godrays-check', true,  on => scene.setGodRays(on));
  wireToggle('toggle-skirt-btn',   'skirt-check',   true,  on => scene.setSkirt(on));
  wireToggle('toggle-territory-btn', 'territory-check', true, on => {
    scene.setTerritoryVisible(on);
    opts.minimapInvalidate(); // the minimap tints owned cells only while the overlay is on
  });
  wireToggle('toggle-resources-btn', 'resources-check', true, on => scene.setResourcesVisible(on));
  wireToggle('toggle-scatter-btn',   'scatter-check',   true, on => scene.setScatterVisible(on));
  wireToggle('toggle-units-btn',     'units-check',     true, on => scene.setUnitsVisible(on));

  // Camera mode is a radio, not a toggle: exactly one check is ever showing, and
  // re-picking the mode already in force is a no-op rather than a flip.
  const cameraRtsCheck  = document.getElementById('camera-rts-check')  as HTMLSpanElement;
  const cameraFreeCheck = document.getElementById('camera-free-check') as HTMLSpanElement;
  function setCameraMode(mode: CameraMode): void {
    scene.setCameraMode(mode);
    cameraRtsCheck.classList.toggle('hidden',  mode !== 'rts');
    cameraFreeCheck.classList.toggle('hidden', mode !== 'free');
  }
  // Submenu parent rows only open their flyout on hover — clicking one must not
  // fall through to the document handler that closes the whole menu bar.
  for (const parent of document.querySelectorAll<HTMLButtonElement>('.menu-submenu > .menu-item')) {
    parent.addEventListener('click', e => e.stopPropagation());
  }
  (document.getElementById('camera-rts-btn') as HTMLButtonElement)
    .addEventListener('click', () => setCameraMode('rts'));
  (document.getElementById('camera-free-btn') as HTMLButtonElement)
    .addEventListener('click', () => setCameraMode('free'));
  setCameraMode(scene.cameraMode); // paint the checks from the scene's opening mode

  return { setPanelVisible };
}
