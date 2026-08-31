import { DEFAULT_WATER_TERRAIN_INDEX } from '@loyalj/hex-world';
import type { HexMap } from '@loyalj/hex-world';
import type { ConfigFieldEx } from '../wizard/configUI.ts';

export interface HeightmapImageData {
  pixels: Uint8ClampedArray;
  width: number;
  height: number;
}

export interface HeightmapConfig {
  image:       HeightmapImageData | null;
  seaLevel:    number;
  elevLow:     number;
  elevHigh:    number;
  autoTerrain: boolean;
}

const SCHEMA: ConfigFieldEx[] = [
  { key: 'image',       label: 'Image file',              type: 'image',   default: null,  group: 'Source' },
  { key: 'seaLevel',    label: 'Sea level (0–255)',        type: 'integer', default: 100, min: 0,    max: 255 },
  { key: 'elevLow',     label: 'Elevation at black',       type: 'integer', default:  -5, min: -128, max: 0   },
  { key: 'elevHigh',    label: 'Elevation at white',       type: 'integer', default:  10, min: 0,    max: 127 },
  { key: 'autoTerrain', label: 'Auto-assign terrain',      type: 'boolean', default: true },
];

export const HeightmapPlugin = {
  id:            'heightmap' as const,
  name:          'Heightmap',
  defaultConfig: {
    image:       null,
    seaLevel:    100,
    elevLow:     -5,
    elevHigh:    10,
    autoTerrain: true,
  } as HeightmapConfig,
  configSchema: SCHEMA,

  generate(map: HexMap, config: HeightmapConfig, _seed: number): void {
    if (!config.image) return;

    const { pixels, width: imgW, height: imgH } = config.image;
    const { seaLevel, elevLow, elevHigh, autoTerrain } = config;
    const elevRange = elevHigh - elevLow;

    for (let row = 0; row < map.height; row++) {
      for (let col = 0; col < map.width; col++) {
        // Bilinear sample of the image at the cell's normalised position
        const nx = map.width  > 1 ? col / (map.width  - 1) : 0.5;
        const ny = map.height > 1 ? row / (map.height - 1) : 0.5;
        const px = nx * (imgW - 1);
        const py = ny * (imgH - 1);
        const x0 = Math.floor(px), x1 = Math.min(x0 + 1, imgW - 1);
        const y0 = Math.floor(py), y1 = Math.min(y0 + 1, imgH - 1);
        const tx = px - x0, ty = py - y0;

        const s = (x: number, y: number) => pixels[(y * imgW + x) * 4]; // red channel (greyscale)
        const brightness =
          s(x0, y0) * (1 - tx) * (1 - ty) +
          s(x1, y0) *      tx  * (1 - ty) +
          s(x0, y1) * (1 - tx) *      ty  +
          s(x1, y1) *      tx  *      ty;

        const elev = Math.max(-128, Math.min(127,
          Math.round(elevLow + (brightness / 255) * elevRange),
        ));

        map.setElevation(col, row, elev);

        if (autoTerrain) {
          const isWater = brightness < seaLevel;
          let terrain: number;
          if (isWater)         terrain = DEFAULT_WATER_TERRAIN_INDEX;
          else if (elev <= 1)  terrain = 3; // Mud — shoreline
          else if (elev <= 6)  terrain = 0; // Grassland
          else if (elev <= 9)  terrain = 4; // Rock
          else                 terrain = 2; // Snow
          map.setTerrain(col, row, terrain);
        }
      }
    }
  },
};
