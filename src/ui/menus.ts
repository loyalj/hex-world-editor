import type { SceneApi, CameraMode } from '../scene.ts';

export interface MenusOptions {
  scene: SceneApi;
  minimapInvalidate(): void;
}

/**
 * The menu bar's dropdown behaviour, the View menu's scene toggles (grid,
 * shadows, sky, god rays, skirt, camera mode, overlays), and the tool-drawer
 * visibility. File-menu entries wire themselves elsewhere: save/load in
 * persistence, terrain/liquid dialogs in the palette, New Map in main.
 */
export function initMenus(opts: MenusOptions): void {
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

  // ---- Tool drawer visibility ----
  // User preference — the rail/View toggles flip it, tool switches don't.
  const leftPanel   = document.getElementById('left-panel')   as HTMLElement;
  const drawerCheck = document.getElementById('drawer-check') as HTMLElement;
  let drawerOpen = true;

  function setDrawerOpen(open: boolean): void {
    drawerOpen = open;
    leftPanel.classList.toggle('hidden', !drawerOpen);
    drawerCheck.classList.toggle('hidden', !drawerOpen);
  }

  (document.getElementById('toggle-drawer-btn') as HTMLButtonElement)
    .addEventListener('click', () => setDrawerOpen(!drawerOpen));
  (document.getElementById('toggle-drawer-menu-btn') as HTMLButtonElement)
    .addEventListener('click', () => setDrawerOpen(!drawerOpen));
  setDrawerOpen(true);

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
}
