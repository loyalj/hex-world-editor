import { buildTerrainTextureArray } from '@loyalj/hex-world';
import type { TerrainDescriptor, TerrainAssetRegistry } from '@loyalj/hex-world';

/**
 * Thumbnails of what each terrain actually looks like — the same procedural
 * noise or uploaded image the ground is textured with, rendered small — so a
 * palette chip is recognisable rather than a flat colour. Returns a data URL
 * per terrain index; an environment without a 2-D canvas (tests) or a
 * failed build yields an empty map, and callers fall back to the flat colour.
 */
export async function renderSwatchPreviews(
  descriptors: TerrainDescriptor[],
  registry: TerrainAssetRegistry,
  size = 40,
): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  if (descriptors.length === 0) return out;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) return out;
  try {
    const tex = await buildTerrainTextureArray(descriptors, registry, { size });
    const { data, depth } = tex.image as { data: Uint8Array; depth: number };
    const slice = size * size * 4;
    for (const desc of descriptors) {
      if (desc.index < 0 || desc.index >= depth) continue;
      const pixels = new Uint8ClampedArray(slice);
      pixels.set(data.subarray(desc.index * slice, (desc.index + 1) * slice));
      ctx.putImageData(new ImageData(pixels, size, size), 0, 0);
      out.set(desc.index, canvas.toDataURL());
    }
    tex.dispose();
  } catch {
    // Fall back to flat colours; nothing else depends on the thumbnails.
  }
  return out;
}

/** Paint a chip with its thumbnail when there is one, else its flat colour. */
export function styleChip(chip: HTMLElement, color: number, previewUrl: string | null | undefined): void {
  chip.style.background = `#${color.toString(16).padStart(6, '0')}`;
  if (previewUrl) {
    chip.style.backgroundImage = `url(${previewUrl})`;
    chip.style.backgroundSize = 'cover';
  }
}
