import * as THREE from 'three';
import type { MapImageTransform } from '@loyalj/hex-world';
import type { SceneApi } from '../scene.js';
import {
  cellsPixelRect, cellsRange, makeMapTransform, mapRange, mapWorldBounds, rasterTerrain, strokeCellSpokes,
} from './minimapRaster.ts';
import type { CellPos, RasterStyle, SpokePass } from './minimapRaster.ts';

/**
 * Longest edge of the rendered image, in pixels. The panel displays it at
 * whatever width the rail gives it, so this is about crispness, not layout —
 * enough to stay sharp on a HiDPI screen without redrawing a huge canvas on
 * every brush stroke.
 */
const TARGET_PIXELS = 480;

/** Pixels per world unit is derived to fit TARGET_PIXELS, then clamped here. */
const MIN_SCALE = 0.5;
const MAX_SCALE = 8;

/** Each elevation step brightens a cell by this much on the minimap. */
const ELEVATION_SHADING = 0.04;

/**
 * Shortest gap between two full terrain redraws, in ms. A full redraw walks
 * every pixel; cell-scoped repaints (a brush stroke) skip this and run on the
 * frame they arrive, since they only touch the pixels under the stroke.
 */
const REDRAW_INTERVAL_MS = 100;

/**
 * Past this many pending cells a repaint is no cheaper than redrawing the
 * whole image, so the pending set collapses into a full redraw.
 */
const MAX_PENDING_CELLS = 4096;

const RIVER_COLOR = '#4d8ecb';
const ROAD_COLOR  = '#b39567';
const BACKGROUND  = 0x131316;

/**
 * Top-down map view for the right rail: terrain, rivers, roads, territory, and
 * fog, with the camera's ground footprint outlined on top and click/drag to
 * send the camera somewhere.
 *
 * Two canvases, because they change at different rates. The base holds the
 * terrain raster (see minimapRaster.ts): a full redraw costs the image's
 * pixel count whatever the map size, and `invalidate(cells)` repaints only
 * the pixels those cells cover, so a brush stroke on a 500-cell map costs the
 * same as on a 50-cell one. The overlay redraws every frame and holds nothing
 * but the viewport quad.
 */
export class Minimap {
  private readonly container:  HTMLElement;
  private readonly base:       HTMLCanvasElement;
  private readonly overlay:    HTMLCanvasElement;
  private readonly scene:      SceneApi;
  private readonly baseCtx:    CanvasRenderingContext2D;
  private readonly overlayCtx: CanvasRenderingContext2D;

  private transform: MapImageTransform | null = null;
  /** The terrain raster, kept between draws so a repaint patches it in place. */
  private image: ImageData | null = null;
  private fullDirty = true;
  private pendingCells: CellPos[] = [];
  private lastDraw  = 0;
  private dragging  = false;

  /** Reused across frames: the footprint runs every frame at 60fps. */
  private readonly footprint: THREE.Vector3[] = [
    new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(),
  ];
  private readonly point = { x: 0, y: 0 };

  constructor(container: HTMLElement, base: HTMLCanvasElement, overlay: HTMLCanvasElement, scene: SceneApi) {
    this.container  = container;
    this.base       = base;
    this.overlay    = overlay;
    this.scene      = scene;
    this.baseCtx    = base.getContext('2d')!;
    this.overlayCtx = overlay.getContext('2d')!;

    container.addEventListener('pointerdown', this.onPointerDown);
    container.addEventListener('pointermove', this.onPointerMove);
    container.addEventListener('pointerup', this.onPointerUp);
    container.addEventListener('pointercancel', this.onPointerUp);
  }

  /**
   * Mark the map content stale; a later `update` redraws it. With `cells`,
   * only the pixels those cells cover are repainted; without, the whole
   * image. Cheap to spam either way.
   */
  invalidate(cells?: Iterable<CellPos>): void {
    if (!cells || this.fullDirty) { this.fullDirty = true; return; }
    for (const c of cells) this.pendingCells.push(c);
    if (this.pendingCells.length > MAX_PENDING_CELLS) {
      this.fullDirty = true;
      this.pendingCells.length = 0;
    }
  }

  /**
   * Call once per frame. A full redraw runs when stale and no more often
   * than `REDRAW_INTERVAL_MS`; cell repaints run at once; the viewport box
   * redraws every frame, since it has to track the camera.
   */
  update(now: number): void {
    if (this.fullDirty) {
      if (now - this.lastDraw >= REDRAW_INTERVAL_MS) {
        this.lastDraw = now;
        this.redraw();
      }
    } else if (this.pendingCells.length > 0) {
      this.repaintCells();
    }
    this.drawViewport();
  }

  dispose(): void {
    this.container.removeEventListener('pointerdown', this.onPointerDown);
    this.container.removeEventListener('pointermove', this.onPointerMove);
    this.container.removeEventListener('pointerup', this.onPointerUp);
    this.container.removeEventListener('pointercancel', this.onPointerUp);
  }

  // --- Drawing ---

  private redraw(): void {
    this.fullDirty = false;
    this.pendingCells.length = 0;

    const { map, layout } = this.scene;
    const bounds    = mapWorldBounds(map, layout);
    const longSide  = Math.max(bounds.maxX - bounds.minX, bounds.maxZ - bounds.minZ);
    const scale     = Math.min(MAX_SCALE, Math.max(MIN_SCALE, TARGET_PIXELS / Math.max(1, longSide)));
    const transform = makeMapTransform(bounds, scale, 2);
    this.transform  = transform;

    if (this.base.width !== transform.width || this.base.height !== transform.height) {
      this.base.width     = this.overlay.width  = transform.width;
      this.base.height    = this.overlay.height = transform.height;
      // The panel sizes itself off the image, so the box never letterboxes.
      this.container.style.aspectRatio = `${transform.width} / ${transform.height}`;
    }
    if (!this.image || this.image.width !== transform.width || this.image.height !== transform.height) {
      this.image = this.baseCtx.createImageData(transform.width, transform.height);
    }

    rasterTerrain(this.image.data, transform, map, layout, this.style());
    this.baseCtx.putImageData(this.image, 0, 0);
    strokeCellSpokes(this.baseCtx, layout, transform, mapRange(map), this.passes(scale), this.fogAlpha());
  }

  /** Patch the raster under the pending cells and re-stroke their neighbourhood. */
  private repaintCells(): void {
    const cells = this.pendingCells;
    this.pendingCells = [];
    const transform = this.transform;
    const image     = this.image;
    if (!transform || !image) { this.fullDirty = true; return; }

    const { map, layout } = this.scene;
    const rect  = cellsPixelRect(cells, transform, layout);
    const range = cellsRange(cells, map);
    if (!rect || !range || rect.x1 <= rect.x0 || rect.y1 <= rect.y0) return;

    rasterTerrain(image.data, transform, map, layout, this.style(), rect);
    this.baseCtx.putImageData(image, 0, 0, rect.x0, rect.y0, rect.x1 - rect.x0, rect.y1 - rect.y0);
    strokeCellSpokes(this.baseCtx, layout, transform, range, this.passes(transform.scale), this.fogAlpha());
  }

  private style(): RasterStyle {
    return {
      terrainDefinitions: this.scene.terrainDefinitions,
      background:         BACKGROUND,
      elevationShading:   ELEVATION_SHADING,
      cellTint:           this.territoryTint(),
      tintAlpha:          0.45,
      fog:                this.scene.fog,
      fogDimOpacity:      this.scene.dimExplored ? 0.55 : 0,
      fogHideUnexplored:  this.scene.hideUnexplored,
    };
  }

  private passes(scale: number): SpokePass[] {
    const { map } = this.scene;
    return [
      {
        color: ROAD_COLOR, width: Math.max(1, scale * 0.45),
        cellHas: (c, r) => map.hasRoads(c, r),
        edgeHas: (c, r, e) => map.hasRoadThroughEdge(c, r, e),
      },
      {
        color: RIVER_COLOR, width: Math.max(1, scale * 0.6),
        cellHas: (c, r) => map.hasRiver(c, r),
        edgeHas: (c, r, e) => map.hasRiverThroughEdge(c, r, e),
      },
    ];
  }

  /** Strokes fade with the terrain under fog: hidden cells draw none, dimmed cells draw faint. */
  private fogAlpha(): ((col: number, row: number) => number) | undefined {
    const fog = this.scene.fog;
    if (!fog) return undefined;
    const raw  = fog.rawData;
    const w    = this.scene.map.width;
    const hide = this.scene.hideUnexplored;
    const dim  = this.scene.dimExplored ? 0.55 : 0;
    return (col, row) => {
      const base = (row * w + col) * 4;
      if (raw[base + 1] !== 255) return hide ? 0 : 1;
      return raw[base] === 255 ? 1 : 1 - dim;
    };
  }

  /**
   * Ownership isn't part of the map image — it lives in the metadata channel —
   * so it rides in through the per-cell tint hook, matching whatever the 3D
   * territory overlay is currently showing.
   */
  private territoryTint(): ((col: number, row: number) => number | null) | undefined {
    const territory = this.scene.territory;
    if (!territory || !territory.visible) return undefined;
    const colors = new Map<string, number>(territory.factions.map(f => [f.id, f.color]));
    return (col, row) => {
      const owner = territory.ownerOf(col, row);
      return owner ? colors.get(owner) ?? null : null;
    };
  }

  private drawViewport(): void {
    const t = this.transform;
    if (!t) return;

    const ctx = this.overlayCtx;
    ctx.clearRect(0, 0, t.width, t.height);

    const quad = this.scene.cameraFootprint(this.footprint);
    if (!quad) return;

    ctx.beginPath();
    for (let i = 0; i < 4; i++) {
      t.worldToImage(quad[i].x, quad[i].z, this.point);
      if (i === 0) ctx.moveTo(this.point.x, this.point.y);
      else         ctx.lineTo(this.point.x, this.point.y);
    }
    ctx.closePath();

    // Dark under-stroke first: a white box vanishes over snow and sand.
    ctx.lineJoin    = 'round';
    ctx.strokeStyle = 'rgba(0,0,0,0.55)';
    ctx.lineWidth   = 4;
    ctx.stroke();
    ctx.strokeStyle = 'rgba(255,255,255,0.9)';
    ctx.lineWidth   = 1.75;
    ctx.stroke();
  }

  // --- Click / drag to jump ---

  private onPointerDown = (e: PointerEvent): void => {
    if (e.button !== 0) return;
    this.dragging = true;
    this.container.setPointerCapture(e.pointerId);
    this.jumpTo(e);
  };

  private onPointerMove = (e: PointerEvent): void => {
    if (this.dragging) this.jumpTo(e);
  };

  private onPointerUp = (e: PointerEvent): void => {
    if (!this.dragging) return;
    this.dragging = false;
    if (this.container.hasPointerCapture(e.pointerId)) this.container.releasePointerCapture(e.pointerId);
  };

  private jumpTo(e: PointerEvent): void {
    const t = this.transform;
    if (!t) return;
    const rect = this.container.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    const { x, z } = t.imageToWorld(
      ((e.clientX - rect.left) / rect.width)  * t.width,
      ((e.clientY - rect.top)  / rect.height) * t.height,
    );
    this.scene.focusWorld(x, z);
  }
}
