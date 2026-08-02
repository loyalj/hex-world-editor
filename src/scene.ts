import * as THREE from 'three';
import {
  HexMap, HexWorld, ChunkManager,
  loadHexPack,
  offsetToHex, hexToOffset, hexRange,
} from '@loyalj/hex-world';
import type { ScatterDefinition, HexCoord, TerrainDefinition, TerrainDescriptor, TerrainAssetRegistry, LiquidTypeDescriptor } from '@loyalj/hex-world';

const MAP_WIDTH    = 100;
const MAP_HEIGHT   = 100;
const CHUNK_SIZE   = 32;
const LOAD_RADIUS  = 5;

export interface SceneApi {
  readonly map: HexMap;
  readonly chunks: ChunkManager;
  hoveredCell: { col: number; row: number } | null;
  brushRadius: number;
  isWater(terrain: number): boolean;
  terrainLookup: Map<number, TerrainDefinition>;
  reload(): void;
  replaceMap(newMap: HexMap): void;
  setPathPreview(path: HexCoord[] | null, erasing?: boolean): void;
  rebuildTerrainFromDescriptors(descriptors: TerrainDescriptor[], registry: TerrainAssetRegistry): Promise<void>;
  setLiquidDescriptors(descriptors: LiquidTypeDescriptor[]): void;
  loadAndApplyHexPack(source: File | Blob): Promise<{
    terrainDescriptors: TerrainDescriptor[];
    liquidDescriptors: LiquidTypeDescriptor[];
    maps: Map<string, HexMap>;
  }>;
}

export async function initScene(container: HTMLElement, terrainDescriptors?: TerrainDescriptor[]): Promise<SceneApi> {
  // Scatter — pine trees on 3 density tiers (layer 0)
  const treeMat = new THREE.MeshLambertMaterial({ color: 0x5e8c2a });
  const pineDefinition: ScatterDefinition = {
    id:         'pine',
    name:       'Pine Trees',
    layerIndex: 0,
    tiers: [
      [{ geometry: new THREE.ConeGeometry(0.42, 2.0, 7), material: treeMat, yOffset: 1.0 }],
      [{ geometry: new THREE.ConeGeometry(0.33, 1.5, 7), material: treeMat, yOffset: 0.75 }],
      [{ geometry: new THREE.ConeGeometry(0.24, 1.0, 7), material: treeMat, yOffset: 0.5 }],
    ],
  };

  // Scatter — rocks / boulders on 3 density tiers (layer 1)
  const rockMat = new THREE.MeshLambertMaterial({ color: 0x8a7a6a });
  const rockDefinition: ScatterDefinition = {
    id:         'rock',
    name:       'Rocks',
    layerIndex: 1,
    tiers: [
      [{ geometry: new THREE.IcosahedronGeometry(0.20, 0), material: rockMat, yOffset: 0.20 }],
      [{ geometry: new THREE.IcosahedronGeometry(0.30, 0), material: rockMat, yOffset: 0.30 }],
      [{ geometry: new THREE.IcosahedronGeometry(0.45, 0), material: rockMat, yOffset: 0.45 }],
    ],
  };

  const world = await HexWorld.create({
    container,
    map: new HexMap({ width: MAP_WIDTH, height: MAP_HEIGHT, featureLayerCount: 2 }),
    terrainDescriptors,
    scatterDefinitions: [pineDefinition, rockDefinition],
    chunkSize:  CHUNK_SIZE,
    loadRadius: LOAD_RADIUS,
    geometryOptions: { colorMode: 'splat' },
    camera: { initialDistance: 60, minPitch: 30, maxPitch: 66, minDistance: 6, maxDistance: 80 },
  });

  // Hover footprint follows the brush every frame
  world.onFrame = () => {
    api.hoveredCell = world.hoveredCell;
    world.overlays.set('hover', world.hoveredCell
      ? hexRange(offsetToHex(world.hoveredCell.col, world.hoveredCell.row), api.brushRadius).map(hexToOffset)
      : null);
  };

  const api: SceneApi = {
    get map() { return world.map; },
    get chunks() { return world.chunks; },
    hoveredCell: null,
    brushRadius: 0,
    reload() { world.chunks.dispose(); },
    replaceMap(newMap: HexMap): void {
      world.setMap(newMap);
    },
    setPathPreview(path: HexCoord[] | null, erasing = false): void {
      if (!path || path.length === 0) {
        world.overlays.set('pathStart', null);
        world.overlays.setPath('pathPreview', null);
        return;
      }
      const color = erasing ? 0xff4444 : 0xffaa22;
      world.overlays.set('pathStart', [hexToOffset(path[0])], { color, opacity: 0.55, yOffset: 0.03 });
      world.overlays.setPath('pathPreview', path.length >= 2 ? path : null, { color });
    },
    isWater(terrain: number): boolean {
      return world.isWater(terrain);
    },
    get terrainLookup(): Map<number, TerrainDefinition> {
      return world.terrainLookup;
    },
    async rebuildTerrainFromDescriptors(descriptors: TerrainDescriptor[], registry: TerrainAssetRegistry): Promise<void> {
      await world.setTerrainDescriptors(descriptors, registry);
    },
    setLiquidDescriptors(descriptors: LiquidTypeDescriptor[]): void {
      world.setLiquidDescriptors(descriptors);
    },
    async loadAndApplyHexPack(source: File | Blob): Promise<{
      terrainDescriptors: TerrainDescriptor[];
      liquidDescriptors: LiquidTypeDescriptor[];
      maps: Map<string, HexMap>;
    }> {
      const pkg = await loadHexPack(source, {
        terrainMaterialOptions: world.terrainMaterialOptions,
      });
      const oldMat = world.applyTerrainDefinitions(pkg.terrainDefinitions, pkg.terrainMaterial);
      if (oldMat !== pkg.terrainMaterial) oldMat.dispose();
      world.setLiquidDescriptors(pkg.liquidDescriptors, pkg.liquidMaterials);
      return { terrainDescriptors: pkg.terrainDescriptors, liquidDescriptors: pkg.liquidDescriptors, maps: pkg.maps };
    },
  };

  return api;
}
