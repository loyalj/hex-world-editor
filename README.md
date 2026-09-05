# Hex World Editor

A browser-based 3D hex map editor for strategy-game worlds, built on the
[`@loyalj/hex-world`](https://www.npmjs.com/package/@loyalj/hex-world) library
with Three.js, TypeScript, and Vite.

Paint terrain and carve elevation on a live low-poly landscape with water,
weather, seasons, and a day/night cycle — then layer on the gameplay data
(territory, resources, units, fog of war) and save it all to a portable file.

## Getting started

```
npm install
npm run dev
```

Then open the printed local URL. `npm run build` produces the static bundle,
`npm test` runs the suite. See [SETUP.md](SETUP.md) for developing against the
library's source instead of the npm package.

## Features

**Map generation** — a New Map wizard (Ctrl+N) with configurable generators:
FBM continents, chunked landmasses, or a heightmap image import, plus map
shape and climate options.

**Terrain & terrain editing**
- Terrain brush and flood fill, both with a hover preview of exactly what a
  fill click would change, and an Alt+click eyedropper. The brush comes in
  solid, ring, and spray shapes at any radius up to 12 (`[` / `]` resize it),
  with a hardness slider that softens a solid brush's rim and a density slider
  for the spray. The fill can match the clicked terrain exactly, its whole
  category (any solid or any liquid), a custom set of terrains, or the
  clicked cell's elevation within a tolerance, and can run over the
  connected region or the whole map. Shift+click stamps a
  straight line from where the last stroke ended, and the status strip
  reports how many cells a click would actually change.
- Elevation sculpting: raise/lower, smooth, flatten, noise, set-absolute,
  slope ramps, and erosion, with a range lock and contour snapping. The same
  shaped, sized brush as the terrain tool, or a fill scope that applies the
  mode across a region matching the clicked cell's elevation (within a
  tolerance) or terrain, connected or map-wide, with a hover preview.
- Rivers and roads with pathfinding, straight, waypoint, and freehand modes;
  rivers can trace downhill with a hover preview, leave a lake wherever a
  drawn or traced river ends on land, reverse a stem's flow, and be erased
  cell by cell or a whole river at once. Alt+click selects a whole river system; a River Check
  dialog lists uphill runs, loops, dead ends, dangling edges, and low
  sources and jumps the camera to each. Roads can weigh terrain and
  elevation costs.
- Scatter layers (pines, broadleaf, bushes, rocks) painted by density with
  elevation and terrain filters.
- Custom rosters: define your own terrain types, liquids (with flow, waves,
  foam, and glow), factions, and resource types — all saved with the map.

**Selection & masking** — pointer, magic wand (terrain or elevation match,
with live region preview), marquee shapes (rectangle, circle, hexagon,
triangle), and lasso. Shift adds, Alt removes, Shift+Alt intersects; the
selection masks every other tool. Terrain locks additionally protect whole
terrain types from edits.

**Gameplay layers** — faction territory painting with border overlays,
resource placement with per-type placement rules, one-unit-per-cell armies
and ships, and paintable fog of war.

**Environment** — time of day with an animated cycle, rain and snow, wind
with gusts that sway the vegetation, seasons (continental or whole-map) with
snow accumulation and freezing liquids, god rays, and cloud shadows.

**Editor chrome** — undo/redo history, minimap with viewport tracking, cell
inspector (with river flow, tributaries, and destination), a Terrains panel
with per-terrain cell counts (click a row to select every cell of that
terrain), map analysis overlays (elevation heatmap, contour lines, river
flow, drainage basins), RTS and free cameras, and an app-wide settings dialog with
themable UI: six presets plus adjustable accent color, dark/light base, and
corner radius.

## Keyboard shortcuts

| Keys | Action |
| --- | --- |
| `0`–`9`, `U` | Switch tools (selection, terrain, elevation, river, road, scatter, environment, territory, resources, fog, units) |
| `Ctrl+Z` / `Ctrl+Y` | Undo / redo |
| `Ctrl+N` / `Ctrl+O` | New map wizard / open |
| `Ctrl+S` / `Ctrl+Shift+S` | Save / save as |
| `Ctrl+A` / `Ctrl+I` / `Esc` | Select all / invert selection / clear |
| `Alt+click` | Eyedropper (terrain, scatter density); select a whole river (river tool) |
| `Shift+click` | Straight line from the last stroke's end (brush tools) |
| `[` / `]` | Shrink / grow the terrain brush (Shift steps by 5) |
| `Shift+drag` | Erase (rivers, roads) |

## File formats

- **`.hexmap.json`** — the full document: map, rosters, environment, fog, and
  units. In Chromium browsers saving uses the File System Access API
  (save-in-place); elsewhere it falls back to a download.
- **`.hxmp`** — the library's compact binary map format (open only).
- **`.hexpack`** — a distributable pack bundling the map with its terrain and
  scatter definitions for consumption by other hex-world apps.

Unsaved work also autosaves to the browser session and is restored on reload.

## Development

- `npm test` — Vitest suite (`tests/`); DOM-dependent tests run in happy-dom
  against the real `index.html`.
- `npm run build` — typecheck + production bundle.
- The app is a thin, modular shell: `src/tools/` owns per-tool behavior,
  `src/ui/` the chrome (menus, palette, persistence, settings, minimap),
  `src/scene.ts` the Three.js scene facade, and the heavy lifting (map data,
  transactions, rendering) lives in the `@loyalj/hex-world` library.
