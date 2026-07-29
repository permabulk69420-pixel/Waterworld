import { Mesh, Object3D, Scene, Vector3 } from 'three';

import { ChunkCollider } from '../physics/ChunkCollider.ts';
import type { CollisionWorld } from '../physics/CollisionWorld.ts';

const SHIP_ROOT_NAME = 'placed:crashed-research-ship:story-crashed-research-ship';
const COLLIDER_PREFIX = 'COLLIDER_';
const FALLBACK_NODE_NAMES = ['Hull', 'RearCargoBay', 'RearCargoThreshold', 'RearGrabLedge'];

const _vertex = new Vector3();

function collectMeshes(root: Object3D, out: Set<Mesh>): void {
  root.traverse((object) => {
    const mesh = object as Mesh;
    if (mesh.isMesh) out.add(mesh);
  });
}

/**
 * Installs static collision for the authored crashed ship.
 *
 * Preferred path: use deliberately simple COLLIDER_* meshes exported with the
 * GLB. If an asset build omitted those, fall back only to the major named hull
 * and rear-access nodes rather than turning every pipe/antenna into collision.
 */
export function installShipCollision(scene: Scene, collision: CollisionWorld): boolean {
  const ship = scene.getObjectByName(SHIP_ROOT_NAME);
  if (!ship) {
    console.warn('[ship-collision] authored ship root not found');
    return false;
  }

  ship.updateWorldMatrix(true, true);

  const meshes = new Set<Mesh>();
  let dedicatedCount = 0;

  ship.traverse((object) => {
    if (!object.name.startsWith(COLLIDER_PREFIX)) return;
    dedicatedCount++;
    collectMeshes(object, meshes);
    // Collider geometry is gameplay-only and must never render.
    object.visible = false;
  });

  if (meshes.size === 0) {
    for (const name of FALLBACK_NODE_NAMES) {
      const node = ship.getObjectByName(name);
      if (node) collectMeshes(node, meshes);
    }
    if (meshes.size > 0) {
      console.warn('[ship-collision] no COLLIDER_* nodes found; using major ship geometry fallback');
    }
  }

  if (meshes.size === 0) {
    console.warn('[ship-collision] no usable collision geometry found in ship GLB');
    return false;
  }

  const positions: number[] = [];
  const indices: number[] = [];
  const min = new Vector3(Infinity, Infinity, Infinity);
  const max = new Vector3(-Infinity, -Infinity, -Infinity);

  for (const mesh of meshes) {
    const geometry = mesh.geometry;
    const position = geometry.getAttribute('position');
    if (!position || position.count < 3) continue;

    mesh.updateWorldMatrix(true, false);
    const base = positions.length / 3;

    for (let i = 0; i < position.count; i++) {
      _vertex
        .set(position.getX(i), position.getY(i), position.getZ(i))
        .applyMatrix4(mesh.matrixWorld);
      positions.push(_vertex.x, _vertex.y, _vertex.z);
      min.min(_vertex);
      max.max(_vertex);
    }

    if (geometry.index) {
      for (let i = 0; i < geometry.index.count; i++) {
        indices.push(base + geometry.index.getX(i));
      }
    } else {
      const triangleVertexCount = position.count - (position.count % 3);
      for (let i = 0; i < triangleVertexCount; i++) indices.push(base + i);
    }
  }

  if (positions.length < 9 || indices.length < 3) {
    console.warn('[ship-collision] collision meshes contained no triangles');
    return false;
  }

  const collider = new ChunkCollider(
    0,
    0,
    new Float32Array(positions),
    new Uint32Array(indices),
    [min.x, min.y, min.z],
    [max.x, max.y, max.z],
    3,
  );

  collision.add('authored:story-crashed-research-ship', collider);
  console.info(
    `[ship-collision] installed ${collider.triangleCount} triangles from ${meshes.size} mesh(es)` +
      (dedicatedCount > 0 ? ` (${dedicatedCount} COLLIDER_* node(s))` : ' (fallback)'),
  );
  return true;
}
