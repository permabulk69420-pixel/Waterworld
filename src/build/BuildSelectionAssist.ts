import {
  Box3,
  BufferGeometry,
  ConeGeometry,
  Line,
  LineBasicMaterial,
  Mesh,
  MeshBasicMaterial,
  Object3D,
  Raycaster,
  Sphere,
  Vector3,
} from 'three';

import type { BuildSystem } from './BuildSystem.ts';
import type { Handedness, VRHands } from '../player/VRHands.ts';

interface BuildAssetDefinitionRuntime {
  id: string;
  label: string;
  selectable?: boolean;
}

interface RuntimeObject {
  record: {
    id: string;
    assetId: string;
  };
  root: Object3D;
}

interface BuildInternals {
  hands: VRHands;
  raycaster: Raycaster;
  pointerLine: Line;
  objects: Map<string, RuntimeObject>;
  selectedId: string | null;
  assetById(assetId: string): BuildAssetDefinitionRuntime | null;
  rayFromHand(handedness: Handedness): boolean;
  select(id: string | null): void;
  selectFromRightRay(): void;
  updatePointer(visible: boolean): void;
  beginGrab(handedness: Handedness): void;
}

interface PointerTarget {
  runtime: RuntimeObject;
  distance: number;
}

const POINTER_LENGTH = 24;
const PICK_ASSIST_MIN_RADIUS = 0.22;
const PICK_ASSIST_MAX_OBJECT_RADIUS = 0.8;

const _box = new Box3();
const _sphere = new Sphere();
const _toCenter = new Vector3();
const _closest = new Vector3();

/**
 * Tightens the first-pass VR Build mode without coupling the authored-world loader
 * to editor ergonomics. BuildSystem still owns layout persistence and transforms;
 * this layer only replaces its pointing/selection behaviour.
 */
export function installBuildSelectionAssist(build: BuildSystem): void {
  const editor = build as unknown as BuildInternals;
  const pointerLine = editor.pointerLine;

  // The old line was only three metres long and only appeared with the panel.
  // Turn it into a long, thin controller-space laser that is useful for world picks.
  pointerLine.geometry.dispose();
  pointerLine.geometry = new BufferGeometry().setFromPoints([
    new Vector3(0, 0, 0),
    new Vector3(0, 0, -1),
  ]);
  const lineMaterial = pointerLine.material as LineBasicMaterial;
  lineMaterial.opacity = 1;
  lineMaterial.depthTest = false;
  pointerLine.renderOrder = 1002;

  const tipMaterial = new MeshBasicMaterial({
    color: 0x70e8ff,
    depthTest: false,
    depthWrite: false,
  });
  const pointerTip = new Mesh(new ConeGeometry(0.025, 0.11, 10), tipMaterial);
  pointerTip.name = 'build-world-pointer-tip';
  pointerTip.rotation.x = -Math.PI / 2;
  pointerTip.renderOrder = 1003;
  pointerTip.visible = false;

  const isSelectable = (runtime: RuntimeObject): boolean => {
    const asset = editor.assetById(runtime.record.assetId);
    return asset?.selectable !== false;
  };

  const findTarget = (): PointerTarget | null => {
    if (!editor.rayFromHand('right')) return null;

    let best: PointerTarget | null = null;

    // Exact geometry hit first. Crucially, non-selectable authored objects such as
    // the crashed ship never participate in the raycast at all.
    for (const runtime of editor.objects.values()) {
      if (!isSelectable(runtime)) continue;
      const hit = editor.raycaster.intersectObject(runtime.root, true)[0];
      if (!hit) continue;
      if (!best || hit.distance < best.distance) best = { runtime, distance: hit.distance };
    }
    if (best) return best;

    // Small props are annoying to hit with a one-pixel VR ray. Give only small
    // objects a modest spherical pick assist; large props still require a real hit.
    const ray = editor.raycaster.ray;
    const far = editor.raycaster.far;
    for (const runtime of editor.objects.values()) {
      if (!isSelectable(runtime)) continue;
      runtime.root.updateWorldMatrix(true, true);
      _box.setFromObject(runtime.root);
      if (_box.isEmpty()) continue;
      _box.getBoundingSphere(_sphere);
      if (_sphere.radius > PICK_ASSIST_MAX_OBJECT_RADIUS) continue;

      _toCenter.subVectors(_sphere.center, ray.origin);
      const along = _toCenter.dot(ray.direction);
      if (along < 0 || along > far) continue;

      _closest.copy(ray.direction).multiplyScalar(along).add(ray.origin);
      const pickRadius = Math.max(_sphere.radius, PICK_ASSIST_MIN_RADIUS);
      if (_closest.distanceToSquared(_sphere.center) > pickRadius * pickRadius) continue;
      if (!best || along < best.distance) best = { runtime, distance: along };
    }

    return best;
  };

  const originalSelect = editor.select.bind(editor);
  editor.select = (id: string | null): void => {
    if (id) {
      const runtime = editor.objects.get(id);
      if (runtime && !isSelectable(runtime)) {
        originalSelect(null);
        return;
      }
    }
    originalSelect(id);
  };

  editor.selectFromRightRay = (): void => {
    const target = findTarget();
    editor.select(target?.runtime.record.id ?? null);
  };

  editor.updatePointer = (): void => {
    const rightGrip = editor.hands.getControllerGrip('right');
    if (!rightGrip) {
      pointerLine.visible = false;
      pointerTip.visible = false;
      return;
    }

    if (pointerLine.parent !== rightGrip) rightGrip.add(pointerLine);
    if (pointerTip.parent !== rightGrip) rightGrip.add(pointerTip);

    const target = findTarget();
    const distance = Math.max(0.18, Math.min(target?.distance ?? POINTER_LENGTH, POINTER_LENGTH));
    pointerLine.scale.set(1, 1, distance);
    pointerLine.visible = true;

    // Put a real arrowhead at the end of the ray. Scale it slightly with distance
    // so it stays readable in the headset without becoming a giant selection blob.
    pointerTip.position.set(0, 0, -distance + 0.055);
    const tipScale = Math.min(2.2, Math.max(0.85, distance * 0.07));
    pointerTip.scale.setScalar(tipScale);
    pointerTip.visible = true;
  };

  const originalBeginGrab = editor.beginGrab.bind(editor);
  editor.beginGrab = (handedness: Handedness): void => {
    // Right grip is now a direct manipulation gesture: point at a small prop and
    // squeeze. It selects that prop first and then lets BuildSystem do the same
    // transform-preserving attach/save path it already used.
    if (handedness === 'right') {
      const target = findTarget();
      if (target) editor.select(target.runtime.record.id);
    }
    originalBeginGrab(handedness);
  };

  const originalDispose = build.dispose.bind(build);
  build.dispose = (): void => {
    pointerTip.removeFromParent();
    pointerTip.geometry.dispose();
    pointerTip.material.dispose();
    originalDispose();
  };
}