import {
  Box3,
  Color,
  Group,
  MathUtils,
  Mesh,
  MeshStandardMaterial,
  Vector3,
  type Material,
  type Object3D,
} from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { BiomeRegistry } from '../config/biomes/index.ts';
import type { Environment } from '../environment/Environment.ts';
import type { DensityField } from '../world/density.ts';

const ASSET_URL = './assets/biomes/safe-shallows/alien_colossus_mushroom_60m_v1_PBRv1.glb';

// This is a navigation landmark, not scatter vegetation. Keep one specimen in a
// fixed general direction from the starting area so players can learn the world by
// silhouette rather than needing a HUD marker.
const TARGET_HEIGHT = 100;
const IDEAL_X = 118;
const IDEAL_Z = -92;
const SEARCH_RADIUS = 48;
const SEARCH_STEP = 8;
const PREFERRED_DEPTH = 18;
const BASE_SINK = 0.45;

const GLOW_NAME_HINT = /glow|gill|emiss|bio|lumen|light|under|ventral/i;
const NO_GLOW_NAME_HINT = /no[-_\s]?glow/i;
const FALLBACK_GLOW_COLOR = new Color(0x42ddff);

const _rawSize = new Vector3();
const _fixedSize = new Vector3();
const _normal = new Vector3();

interface GlowMaterialState {
  material: MeshStandardMaterial;
  color: Color;
  nightIntensity: number;
}

/**
 * One 100 m alien-mushroom landmark for the Safe Shallows.
 *
 * The current 60 m source asset is authored Z-up, so the loader rotates it into Three.js
 * Y-up space before grounding and normalising the final visible height to 100 metres.
 * Authored underside emissive/gill/glow materials are cloned and driven by the
 * existing Environment.daylight value so the underside wakes up naturally after sunset.
 */
export class ColossusMushroomSystem {
  readonly ready: Promise<void>;

  private readonly glowMaterials: GlowMaterialState[] = [];
  private root: Group | null = null;
  private loadFailed = false;

  constructor(
    private readonly parent: Object3D,
    private readonly density: DensityField,
    private readonly biomes: BiomeRegistry,
    private readonly environment: Environment,
  ) {
    this.ready = this.load();
  }

  private async load(): Promise<void> {
    try {
      const gltf = await new GLTFLoader().loadAsync(ASSET_URL);
      gltf.scene.updateMatrixWorld(true);

      const rawBounds = new Box3().setFromObject(gltf.scene);
      rawBounds.getSize(_rawSize);
      if (_rawSize.lengthSq() <= 0.001) throw new Error('colossus mushroom GLB has invalid bounds');

      // This asset is Z-up. Its cap is roughly as wide as the full mushroom is tall,
      // so a bounds-ratio heuristic cannot reliably infer the up axis. Apply the
      // authored-axis correction explicitly before measuring, grounding and scaling.
      const axisFix = new Group();
      axisFix.name = 'flora:colossus-axis-fix';
      axisFix.rotation.x = -Math.PI / 2;
      axisFix.add(gltf.scene);

      const visual = new Group();
      visual.name = 'flora:alien-colossus-mushroom-visual';
      visual.add(axisFix);
      visual.updateMatrixWorld(true);

      let fixedBounds = new Box3().setFromObject(visual);
      fixedBounds.getSize(_fixedSize);
      const authoredHeight = _fixedSize.y;
      if (!Number.isFinite(authoredHeight) || authoredHeight <= 0.001) {
        throw new Error('colossus mushroom has invalid corrected height');
      }

      // Ground the lowest authored point before applying the final uniform scale.
      axisFix.position.y -= fixedBounds.min.y;
      visual.updateMatrixWorld(true);
      fixedBounds = new Box3().setFromObject(visual);

      const scale = TARGET_HEIGHT / (fixedBounds.max.y - fixedBounds.min.y);
      visual.scale.setScalar(scale);

      gltf.scene.traverse((object) => {
        if (!(object instanceof Mesh)) return;
        object.castShadow = false;
        object.receiveShadow = false;

        const original = object.material;
        if (Array.isArray(original)) {
          object.material = original.map((material) => this.cloneMaterial(material, object.name));
        } else {
          object.material = this.cloneMaterial(original, object.name);
        }
      });

      const placement = this.findLandmarkPlacement();
      const root = new Group();
      root.name = 'flora:alien-colossus-mushroom-landmark';
      root.position.set(placement.x, placement.y - BASE_SINK, placement.z);
      // Keep a giant landmark essentially vertical even if its chosen seabed patch
      // has a slight slope. A large lean reads accidental at this scale.
      root.rotation.y = 0.72;
      root.add(visual);
      this.parent.add(root);
      this.root = root;

      this.update(0);

      const topY = root.position.y + TARGET_HEIGHT;
      console.info(
        `[flora] colossus mushroom loaded: raw ${_rawSize.x.toFixed(1)} x ${_rawSize.y.toFixed(1)} x ${_rawSize.z.toFixed(1)} m; ` +
          `normalised to ${TARGET_HEIGHT} m at (${placement.x.toFixed(1)}, ${placement.z.toFixed(1)}); ` +
          `seabed ${placement.y.toFixed(1)} m, top ${topY.toFixed(1)} m, glow materials ${this.glowMaterials.length}`,
      );

      if (this.glowMaterials.length === 0) {
        console.warn(
          '[flora] colossus mushroom has no detectable emissive/gill/glow material; landmark will render normally but cannot night-glow selectively',
        );
      }
    } catch (error) {
      this.loadFailed = true;
      console.warn(`[flora] failed to load colossus mushroom at ${ASSET_URL}`, error);
    }
  }

  private cloneMaterial(material: Material, meshName: string): Material {
    const clone = material.clone();
    if (!(clone instanceof MeshStandardMaterial)) return clone;

    const hint = `${clone.name} ${meshName}`;
    const explicitlyNoGlow = NO_GLOW_NAME_HINT.test(hint);
    const hasAuthoredEmission =
      clone.emissiveMap !== null || clone.emissive.r + clone.emissive.g + clone.emissive.b > 0.015;
    const looksLikeGlowPart = GLOW_NAME_HINT.test(hint);

    // The new PBR colossus deliberately names non-emissive surfaces *_NoGlow.
    // Honour that before fuzzy name matching so the trunk/cap never become neon
    // merely because their material name contains the literal word "Glow".
    if (!explicitlyNoGlow && (hasAuthoredEmission || looksLikeGlowPart)) {
      const color = clone.emissive.clone();
      if (color.r + color.g + color.b < 0.015) color.copy(FALLBACK_GLOW_COLOR);

      // Respect strong authored emissive values, but guarantee enough headroom for
      // the colossal underside to read through night water/fog.
      const nightIntensity = Math.max(2.6, clone.emissiveIntensity || 1);
      clone.emissive.copy(color);
      clone.emissiveIntensity = 0.025;
      this.glowMaterials.push({ material: clone, color, nightIntensity });
    }

    return clone;
  }

  private findLandmarkPlacement(): Vector3 {
    let best: Vector3 | null = null;
    let bestScore = Number.NEGATIVE_INFINITY;

    for (let dz = -SEARCH_RADIUS; dz <= SEARCH_RADIUS; dz += SEARCH_STEP) {
      for (let dx = -SEARCH_RADIUS; dx <= SEARCH_RADIUS; dx += SEARCH_STEP) {
        const x = IDEAL_X + dx;
        const z = IDEAL_Z + dz;
        if (this.biomes.biomeAt(x, z).id !== 'SAFE_SHALLOWS') continue;

        const seabed = this.density.seabedAt(x, z);
        const depth = this.environment.seaLevel - seabed;
        if (depth < 5 || depth > 42) continue;

        const e = 1.4;
        _normal
          .set(
            this.density.seabedAt(x - e, z) - this.density.seabedAt(x + e, z),
            2 * e,
            this.density.seabedAt(x, z - e) - this.density.seabedAt(x, z + e),
          )
          .normalize();

        // Prefer a fairly flat patch, a useful amount of mushroom above the water,
        // and proximity to the intended landmark bearing from spawn.
        const distanceFromIdeal = Math.hypot(dx, dz);
        const depthPenalty = Math.abs(depth - PREFERRED_DEPTH);
        const score = _normal.y * 30 - distanceFromIdeal * 0.22 - depthPenalty * 0.45;
        if (score <= bestScore) continue;

        bestScore = score;
        best = new Vector3(x, seabed, z);
      }
    }

    if (best) return best;

    const y = this.density.seabedAt(IDEAL_X, IDEAL_Z);
    return new Vector3(IDEAL_X, y, IDEAL_Z);
  }

  /** Copies the actually placed landmark root position into target. */
  getWorldPosition(target: Vector3): boolean {
    if (!this.root) return false;
    this.root.updateMatrixWorld(true);
    this.root.getWorldPosition(target);
    return true;
  }

  update(elapsed: number): void {
    if (this.loadFailed || this.glowMaterials.length === 0) return;

    const night = Math.pow(MathUtils.clamp(1 - this.environment.daylight, 0, 1), 1.15);
    const pulse = 0.93 + Math.sin(elapsed * 0.52) * 0.07;

    for (const state of this.glowMaterials) {
      state.material.emissive.copy(state.color);
      state.material.emissiveIntensity = MathUtils.lerp(
        0.025,
        state.nightIntensity * pulse,
        night,
      );
    }
  }

  dispose(): void {
    if (!this.root) return;
    this.root.traverse((object) => {
      if (!(object instanceof Mesh)) return;
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      for (const material of materials) material.dispose();
    });
    this.root.removeFromParent();
    this.root = null;
    this.glowMaterials.length = 0;
  }
}
