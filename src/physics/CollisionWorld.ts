import { Box3, Vector3 } from 'three';
import { ChunkCollider } from './ChunkCollider.ts';
import type { Capsule } from './Capsule.ts';
import { capsuleTriangleContact, type Contact } from './triangleCapsule.ts';

export interface ResolveResult {
  /** Number of triangles that pushed on the capsule this step. */
  contacts: number;
  /** Total distance the capsule was pushed out, in metres. */
  correction: number;
  /** Surface normal of the deepest contact, or null. */
  deepestNormal: Vector3 | null;
  /** True when the capsule was resting on something roughly floor-like. */
  grounded: boolean;
}

const _box = new Box3();
const _a = new Vector3();
const _b = new Vector3();
const _c = new Vector3();
const _push = new Vector3();
const _deepest = new Vector3();
const _contact: Contact = { normal: new Vector3(), depth: 0 };

/**
 * Static collision for the streamed terrain.
 *
 * Colliders are added and removed by the chunk manager, so collision coverage
 * always matches what is actually rendered. Queries only touch the chunks the
 * capsule's bounding box overlaps.
 */
export class CollisionWorld {
  private readonly colliders = new Map<string, ChunkCollider>();
  private readonly scratch: number[] = [];

  /** Pushed out this much extra so the capsule does not re-touch next frame. */
  skin = 0.005;
  /** Solver iterations. 4 is plenty for terrain; corners settle in 2-3. */
  iterations = 4;

  add(key: string, collider: ChunkCollider): void {
    this.colliders.set(key, collider);
  }

  remove(key: string): void {
    this.colliders.delete(key);
  }

  has(key: string): boolean {
    return this.colliders.has(key);
  }

  get colliderCount(): number {
    return this.colliders.size;
  }

  get triangleCount(): number {
    let n = 0;
    for (const c of this.colliders.values()) n += c.triangleCount;
    return n;
  }

  get byteSize(): number {
    let n = 0;
    for (const c of this.colliders.values()) n += c.byteSize;
    return n;
  }

  /**
   * Pushes `capsule` out of the terrain, in place, and cancels the component of
   * `velocity` heading into each surface it hit.
   *
   * Depenetration is applied contact-by-contact within an iteration (rather
   * than summing every normal at once) which stops opposite walls in a narrow
   * tunnel from fighting each other and jittering the player.
   */
  resolveCapsule(capsule: Capsule, velocity: Vector3 | null): ResolveResult {
    let totalContacts = 0;
    let correction = 0;
    let deepestDepth = 0;
    let haveDeepest = false;
    let grounded = false;

    for (let iter = 0; iter < this.iterations; iter++) {
      capsule.getBounds(_box);
      const tris = this.scratch;
      let iterationContacts = 0;

      for (const collider of this.colliders.values()) {
        if (!collider.bounds.intersectsBox(_box)) continue;
        tris.length = 0;
        collider.queryBox(_box, tris);

        for (let i = 0; i < tris.length; i++) {
          collider.getTriangle(tris[i], _a, _b, _c);
          if (!capsuleTriangleContact(capsule, _a, _b, _c, _contact)) continue;
          if (_contact.depth <= 0) continue;

          iterationContacts++;
          totalContacts++;

          const push = _contact.depth + this.skin;
          _push.copy(_contact.normal).multiplyScalar(push);
          capsule.translate(_push);
          correction += push;

          if (_contact.normal.y > 0.55) grounded = true;
          if (_contact.depth > deepestDepth) {
            deepestDepth = _contact.depth;
            _deepest.copy(_contact.normal);
            haveDeepest = true;
          }

          if (velocity) {
            const into = velocity.dot(_contact.normal);
            if (into < 0) velocity.addScaledVector(_contact.normal, -into);
          }

          // The capsule moved; refresh the query box for the remaining
          // triangles in this iteration.
          capsule.getBounds(_box);
        }
      }

      if (iterationContacts === 0) break;
    }

    return {
      contacts: totalContacts,
      correction,
      deepestNormal: haveDeepest ? _deepest : null,
      grounded,
    };
  }
}
