import {
  BufferAttribute,
  BufferGeometry,
  CapsuleGeometry,
  Color,
  Group,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshBasicMaterial,
  Scene,
  Vector3,
} from 'three';
import type { WorldConfig } from '../config/worldConfig.ts';
import type { Capsule } from '../physics/Capsule.ts';

/**
 * Optional world-space debug visuals: chunk boundaries and the player's
 * collision capsule. Both are off by default and cost nothing when hidden.
 */
export class DebugOverlays {
  readonly root = new Group();

  private readonly chunkLines: LineSegments;
  private readonly capsuleMesh: Mesh;
  private lastChunkSignature = '';

  constructor(
    private readonly config: WorldConfig,
    scene: Scene,
  ) {
    this.root.name = 'debug-overlays';
    this.root.matrixAutoUpdate = false;

    this.chunkLines = new LineSegments(
      new BufferGeometry(),
      new LineBasicMaterial({ color: new Color(0x39d7ff), fog: false, transparent: true, opacity: 0.5 }),
    );
    this.chunkLines.frustumCulled = false;
    this.chunkLines.visible = false;
    this.root.add(this.chunkLines);

    this.capsuleMesh = new Mesh(
      new CapsuleGeometry(0.32, 1.1, 4, 12),
      new MeshBasicMaterial({ color: 0xffd166, wireframe: true, fog: false, depthTest: false }),
    );
    this.capsuleMesh.frustumCulled = false;
    this.capsuleMesh.visible = false;
    this.capsuleMesh.renderOrder = 999;
    this.root.add(this.capsuleMesh);

    scene.add(this.root);
  }

  get chunkBoundsVisible(): boolean {
    return this.chunkLines.visible;
  }

  toggleChunkBounds(): void {
    this.chunkLines.visible = !this.chunkLines.visible;
    this.lastChunkSignature = '';
  }

  get capsuleVisible(): boolean {
    return this.capsuleMesh.visible;
  }

  toggleCapsule(): void {
    this.capsuleMesh.visible = !this.capsuleMesh.visible;
  }

  update(loadedChunkKeys: Iterable<string>, capsule: Capsule): void {
    if (this.capsuleMesh.visible) {
      const center = capsule.getCenter(new Vector3());
      this.capsuleMesh.position.copy(center);
      const length = capsule.start.distanceTo(capsule.end);
      this.capsuleMesh.scale.set(
        capsule.radius / 0.32,
        length > 0 ? length / 1.1 : 1,
        capsule.radius / 0.32,
      );
    }

    if (!this.chunkLines.visible) return;

    const keys = [...loadedChunkKeys].sort();
    const signature = keys.join('|');
    if (signature === this.lastChunkSignature) return;
    this.lastChunkSignature = signature;
    this.rebuildChunkLines(keys);
  }

  private rebuildChunkLines(keys: string[]): void {
    const size = this.config.chunkSize;
    const y0 = this.config.worldMinY;
    const y1 = this.config.worldMaxY;
    const positions: number[] = [];

    for (const key of keys) {
      const [cxs, czs] = key.split(',');
      const x0 = Number(cxs) * size;
      const z0 = Number(czs) * size;
      const x1 = x0 + size;
      const z1 = z0 + size;

      const corners: [number, number][] = [
        [x0, z0],
        [x1, z0],
        [x1, z1],
        [x0, z1],
      ];

      // Vertical edges.
      for (const [x, z] of corners) {
        positions.push(x, y0, z, x, y1, z);
      }
      // Top and bottom rings.
      for (const y of [y0, y1]) {
        for (let i = 0; i < 4; i++) {
          const a = corners[i];
          const b = corners[(i + 1) % 4];
          positions.push(a[0], y, a[1], b[0], y, b[1]);
        }
      }
    }

    const geometry = this.chunkLines.geometry;
    geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
    geometry.computeBoundingSphere();
  }

  dispose(): void {
    this.chunkLines.geometry.dispose();
    (this.chunkLines.material as LineBasicMaterial).dispose();
    this.capsuleMesh.geometry.dispose();
    (this.capsuleMesh.material as MeshBasicMaterial).dispose();
    this.root.removeFromParent();
  }
}
