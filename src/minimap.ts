import * as THREE from 'three';
import {
  drawMapImage, getMapImageTransform, getMapWorldBounds,
  type MapImageTransform,
} from '@loyalj/hex-world';
import type { SceneApi } from './scene.js';

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
 * Shortest gap between two terrain redraws, in ms. A redraw walks every cell,
 * so this is what lets callers invalidate freely — once per brushed cell, even
 * — and still see live-ish feedback without a full map pass every frame.
 */
const REDRAW_INTERVAL_MS = 100;

/**
 * Top-down map view for the right rail: terrain, rivers, roads, territory, and
 * fog, with the camera's ground footprint outlined on top and click/drag to
 * send the camera somewhere.
 *
 * Two canvases, because they change at different rates. The base redraws only
 * when the map does (`invalidate`), and it draws straight into the canvas via
 * `drawMapImage` — no Blob encode, no object URL — so a paint stroke costs one
 * synchronous pass. The overlay redraws every frame and holds nothing but the
 * viewport quad.
 */
export class Minimap {
  private readonly container:  HTMLElement;
  private readonly base:       HTMLCanvasElement;
  private readonly overlay:    HTMLCanvasElement;
  private readonly scene:      SceneApi;
  private readonly baseCtx:    CanvasRenderingContext2D;
  private readonly overlayCtx: CanvasRenderingContext2D;

  private transform: MapImageTransform | null = null;
  private dirty     = true;
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

  /** Mark the map content stale; a later `update` redraws it. Cheap to spam. */
  invalidate(): void {
    this.dirty = true;
  }

  /**
   * Call once per frame. The terrain redraws only when stale and no more often
   * than `REDRAW_INTERVAL_MS`; the viewport box redraws every frame, since it
   * has to track the camera.
   */
  update(now: number): void {
    if (this.dirty && now - this.lastDraw >= REDRAW_INTERVAL_MS) {
      this.lastDraw = now;
      this.redraw();
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
    this.dirty = false;

    const { map, layout } = this.scene;
    const scale = this.pickScale();

    const transform = getMapImageTransform(map, layout, { scale, padding: 2 });
    if (this.base.width !== transform.width || this.base.height !== transform.height) {
      this.base.width     = this.overlay.width  = transform.width;
      this.base.height    = this.overlay.height = transform.height;
      // The panel sizes itself off the image, so the box never letterboxes.
      this.container.style.aspectRatio = `${transform.width} / ${transform.height}`;
    }

    this.transform = drawMapImage(this.baseCtx, map, layout, this.scene.terrainDefinitions, {
      scale,
      padding:           2,
      background:        '#131316',
      elevationShading:  ELEVATION_SHADING,
      rivers:            true,
      roads:             true,
      cellTint:          this.territoryTint(),
      fog:               this.scene.fog ?? undefined,
      fogDimOpacity:     this.scene.dimExplored ? 0.55 : 0,
      fogHideUnexplored: this.scene.hideUnexplored,
    });
  }

  /**
   * Ownership isn't part of the map image the library draws — it lives in the
   * metadata channel — so it rides in through the per-cell tint hook, matching
   * whatever the 3D territory overlay is currently showing.
   */
  private territoryTint(): ((col: number, row: number) => string | null) | undefined {
    const territory = this.scene.territory;
    if (!territory || !territory.visible) return undefined;

    // One CSS string per faction, built once instead of per cell.
    const colors = new Map<string, string>();
    for (const f of territory.factions) {
      const c = new THREE.Color(f.color);
      colors.set(f.id, `rgba(${Math.round(c.r * 255)},${Math.round(c.g * 255)},${Math.round(c.b * 255)},0.45)`);
    }

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

  /** Pixels per world unit that fits the map's long side into TARGET_PIXELS. */
  private pickScale(): number {
    const { minX, maxX, minZ, maxZ } = getMapWorldBounds(this.scene.map, this.scene.layout);
    const longSide = Math.max(maxX - minX, maxZ - minZ);
    return Math.min(MAX_SCALE, Math.max(MIN_SCALE, TARGET_PIXELS / Math.max(1, longSide)));
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
