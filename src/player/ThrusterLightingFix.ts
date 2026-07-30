import {
  Color,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  type Material,
  type Scene,
} from 'three';

/**
 * The current thruster loader intentionally converts its GLB materials to
 * MeshBasicMaterial. That keeps them visible, but also makes them read as if
 * they are self illuminated at night. Convert spawned motor instances back to
 * ordinary lit materials without touching their grabbing/thrust behaviour.
 */
export class ThrusterLightingFix {
  private readonly fixedRoots = new WeakSet<object>();

  constructor(private readonly scene: Scene) {}

  update(): void {
    this.fixRoot(this.scene.getObjectByName('world-hand-motor-left'));
    this.fixRoot(this.scene.getObjectByName('world-hand-motor-right'));
  }

  private fixRoot(root: ReturnType<Scene['getObjectByName']>): void {
    if (!root || this.fixedRoots.has(root)) return;

    root.traverse((object) => {
      if (!(object instanceof Mesh)) return;
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      const converted = materials.map((material) => this.toLitMaterial(material, object));
      object.material = Array.isArray(object.material) ? converted : converted[0]!;
    });

    this.fixedRoots.add(root);
  }

  private toLitMaterial(material: Material, mesh: Mesh): Material {
    if (!(material instanceof MeshBasicMaterial)) {
      const candidate = material as Material & {
        emissive?: Color;
        emissiveIntensity?: number;
      };
      candidate.emissive?.set(0x000000);
      if (typeof candidate.emissiveIntensity === 'number') candidate.emissiveIntensity = 0;
      return material;
    }

    const lit = new MeshStandardMaterial({
      name: `${material.name || 'thruster'}-lit`,
      color: material.color.clone(),
      map: material.map,
      alphaMap: material.alphaMap,
      aoMap: material.aoMap,
      lightMap: material.lightMap,
      transparent: material.transparent,
      opacity: material.opacity,
      alphaTest: material.alphaTest,
      side: material.side,
      depthTest: material.depthTest,
      depthWrite: material.depthWrite,
      vertexColors: mesh.geometry.getAttribute('color') !== undefined,
      roughness: 0.58,
      metalness: 0.24,
      emissive: 0x000000,
      emissiveIntensity: 0,
    });
    lit.toneMapped = material.toneMapped;
    return lit;
  }
}
