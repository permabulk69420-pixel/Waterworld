import type { BiomeConfig } from './types.ts';
import { SAFE_SHALLOWS } from './safeShallows.ts';

export type { BiomeConfig } from './types.ts';
export { SAFE_SHALLOWS } from './safeShallows.ts';

/**
 * Biome registry + world biome map.
 *
 * Only one biome exists today, so `biomeAt()` returns it everywhere. When
 * neighbouring biomes are added, this is the single place that changes:
 * register the config, and make `biomeAt()` map world XZ (or a low frequency
 * region noise) onto biome ids. The terrain engine is already fully driven by
 * whatever this returns.
 *
 * The one rule to preserve: `biomeAt()` must stay a pure, deterministic
 * function of world position, or chunks will not regenerate identically.
 */
export class BiomeRegistry {
  private readonly biomes = new Map<string, BiomeConfig>();
  private defaultBiomeId: string;

  constructor(biomes: readonly BiomeConfig[], defaultBiomeId: string) {
    for (const b of biomes) this.biomes.set(b.id, b);
    if (!this.biomes.has(defaultBiomeId)) {
      throw new Error(`Default biome "${defaultBiomeId}" is not registered`);
    }
    this.defaultBiomeId = defaultBiomeId;
  }

  register(biome: BiomeConfig): void {
    this.biomes.set(biome.id, biome);
  }

  get(id: string): BiomeConfig {
    const biome = this.biomes.get(id);
    if (!biome) throw new Error(`Unknown biome "${id}"`);
    return biome;
  }

  list(): BiomeConfig[] {
    return [...this.biomes.values()];
  }

  /**
   * Biome at a world position. Deterministic and cheap - it is called once per
   * terrain column, so keep it that way (region noise, Voronoi regions, etc).
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  biomeAt(_x: number, _z: number): BiomeConfig {
    return this.get(this.defaultBiomeId);
  }

  /**
   * Blend weight helper for future biome borders. Returns the dominant biome
   * plus a 0..1 blend factor toward it; today it is always a hard 1.
   */
  sample(x: number, z: number): { biome: BiomeConfig; weight: number } {
    return { biome: this.biomeAt(x, z), weight: 1 };
  }
}

export function createDefaultBiomeRegistry(): BiomeRegistry {
  return new BiomeRegistry([SAFE_SHALLOWS], SAFE_SHALLOWS.id);
}
