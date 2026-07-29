import {
  AnimationMixer,
  Group,
  Matrix4,
  MathUtils,
  type AnimationAction,
  type Mesh,
  type Object3D,
  type Vector3,
  type WebGLRenderer,
} from 'three';
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';

// Reuse the exact rigged hand assets from the apartment project. These are kept
// as remote URLs for now so Waterworld can use them immediately without making
// you fight Android's binary upload picker. They can be copied into
// public/assets/player/hands later without changing the hand system itself.
const HAND_URLS = Object.freeze({
  left: 'https://raw.githubusercontent.com/permabulk69420-pixel/dumbgame/main/assets/models/hands/LeftHand.glb',
  right: 'https://raw.githubusercontent.com/permabulk69420-pixel/dumbgame/main/assets/models/hands/RightHand.glb',
});

type Handedness = keyof typeof HAND_URLS;

interface InputSourceLike {
  handedness?: string;
  gamepad?: Gamepad | null;
}

interface MixerState {
  mixer: AnimationMixer;
  actions: Map<string, AnimationAction>;
  current: AnimationAction | null;
}

interface HandState {
  controller: Group;
  grip: Group;
  objectGrip: Group;
  inputSource: InputSourceLike | null;
  handedness: Handedness | null;
  handAnchor: Group | null;
  handRoot: Object3D | null;
  gripSocket: Object3D | null;
  indexTip: Object3D | null;
  mixerState: MixerState | null;
}

const HAND_GRIP_OFFSETS = Object.freeze({
  left: Object.freeze({ rotationZ: Math.PI / 2 }),
  right: Object.freeze({ rotationZ: -Math.PI / 2 }),
});

const gripMatrix = new Matrix4();

function isHandedness(value: string | undefined): value is Handedness {
  return value === 'left' || value === 'right';
}

function prepareModel(root: Object3D): Object3D {
  root.traverse((object) => {
    const mesh = object as Mesh;
    if (!mesh.isMesh) return;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
  });
  return root;
}

function createActions(root: Object3D, clips: GLTF['animations']): MixerState {
  const mixer = new AnimationMixer(root);
  const actions = new Map<string, AnimationAction>();

  for (const clip of clips) {
    const action = mixer.clipAction(clip);
    action.play();
    action.paused = true;
    action.weight = 0;
    actions.set(clip.name, action);
  }

  return { mixer, actions, current: null };
}

function setPose(state: MixerState, name: string, amount: number): void {
  const action = state.actions.get(name);
  if (!action) return;

  if (state.current && state.current !== action) state.current.weight = 0;
  state.current = action;
  action.enabled = true;
  action.paused = true;
  action.weight = 1;
  action.time = MathUtils.clamp(amount, 0, 1) * action.getClip().duration;
}

/**
 * Visible Quest hands for Waterworld.
 *
 * This is the apartment hand system adapted to Waterworld's existing renderer
 * and rig. It keeps controller target-ray nodes separate from grip nodes,
 * attaches the hand meshes to the tracked grip poses, scrubs the baked hand
 * animations from trigger/squeeze input, and exposes palm grip anchors for
 * held objects later.
 */
export class VRHands {
  readonly ready: Promise<void>;

  private readonly states: HandState[] = [];
  private readonly models: Record<Handedness, GLTF | null> = { left: null, right: null };
  private visible = true;
  private loaded = false;

  constructor(
    private readonly renderer: WebGLRenderer,
    parent: Group,
  ) {
    for (let index = 0; index < 2; index++) {
      const controller = renderer.xr.getController(index);
      const grip = renderer.xr.getControllerGrip(index);
      const objectGrip = new Group();
      objectGrip.name = `controller-${index}-held-object-anchor`;
      grip.add(objectGrip);
      parent.add(controller, grip);

      const state: HandState = {
        controller,
        grip,
        objectGrip,
        inputSource: null,
        handedness: null,
        handAnchor: null,
        handRoot: null,
        gripSocket: null,
        indexTip: null,
        mixerState: null,
      };
      this.states.push(state);

      controller.addEventListener('connected', (event) => {
        const source = (event as unknown as { data?: InputSourceLike }).data ?? null;
        state.inputSource = source;
        state.handedness = isHandedness(source?.handedness) ? source.handedness : null;
        state.objectGrip.name = `${state.handedness ?? 'unknown'}-held-object-anchor`;
        if (this.loaded && state.handedness) this.attach(state, state.handedness);
      });

      controller.addEventListener('disconnected', () => {
        state.inputSource = null;
        state.handedness = null;
        this.detach(state);
      });
    }

    this.ready = this.loadModels();
  }

  private async loadModels(): Promise<void> {
    const loader = new GLTFLoader();
    const results = await Promise.allSettled([
      loader.loadAsync(HAND_URLS.left),
      loader.loadAsync(HAND_URLS.right),
    ]);

    if (results[0].status === 'fulfilled') this.models.left = results[0].value;
    else console.warn('[hands] left apartment hand failed to load', results[0].reason);

    if (results[1].status === 'fulfilled') this.models.right = results[1].value;
    else console.warn('[hands] right apartment hand failed to load', results[1].reason);

    this.loaded = true;
    for (const state of this.states) {
      if (state.handedness) this.attach(state, state.handedness);
    }
  }

  private resetObjectGrip(state: HandState): void {
    if (state.objectGrip.parent !== state.grip) state.grip.add(state.objectGrip);
    state.objectGrip.position.set(0, 0, 0);
    state.objectGrip.quaternion.identity();
    state.objectGrip.scale.set(1, 1, 1);
  }

  private syncObjectGrip(state: HandState): void {
    if (!state.gripSocket) {
      this.resetObjectGrip(state);
      return;
    }

    if (state.objectGrip.parent !== state.grip) state.grip.add(state.objectGrip);
    state.grip.updateWorldMatrix(true, false);
    state.gripSocket.updateWorldMatrix(true, false);
    gripMatrix
      .copy(state.grip.matrixWorld)
      .invert()
      .multiply(state.gripSocket.matrixWorld)
      .decompose(state.objectGrip.position, state.objectGrip.quaternion, state.objectGrip.scale);
    state.objectGrip.updateMatrixWorld(true);
  }

  private detach(state: HandState): void {
    this.resetObjectGrip(state);
    if (state.handAnchor) state.handAnchor.removeFromParent();
    state.mixerState?.mixer.stopAllAction();
    state.handAnchor = null;
    state.handRoot = null;
    state.gripSocket = null;
    state.indexTip = null;
    state.mixerState = null;
  }

  private attach(state: HandState, handedness: Handedness): void {
    this.detach(state);
    const gltf = this.models[handedness];
    if (!gltf) return;

    const root = prepareModel(gltf.scene);
    root.name = `${handedness}-vr-hand`;

    const anchor = new Group();
    anchor.name = `${handedness}-hand-grip-offset`;
    anchor.rotation.z = HAND_GRIP_OFFSETS[handedness].rotationZ;
    anchor.visible = this.visible;
    anchor.add(root);
    state.grip.add(anchor);

    const side = handedness === 'left' ? 'l' : 'r';
    const gripSocket = root.getObjectByName(`b_${side}_grip`);
    const indexTip = root.getObjectByName(`b_${side}_index_ignore`);

    if (!gripSocket) console.warn(`[hands] missing b_${side}_grip socket`);
    if (!indexTip) console.warn(`[hands] missing b_${side}_index_ignore fingertip`);

    state.handAnchor = anchor;
    state.handRoot = root;
    state.gripSocket = gripSocket ?? null;
    state.indexTip = indexTip ?? null;
    state.mixerState = createActions(root, gltf.animations);
    setPose(state.mixerState, 'Open', 0);
    state.mixerState.mixer.update(0);
    this.syncObjectGrip(state);
  }

  update(dt: number): void {
    if (!this.renderer.xr.isPresenting) return;

    for (const state of this.states) {
      const mixerState = state.mixerState;
      if (!mixerState) continue;

      const gamepad = state.inputSource?.gamepad;
      const trigger = gamepad?.buttons[0]?.value ?? 0;
      const squeeze = gamepad?.buttons[1]?.value ?? 0;

      if (squeeze > 0.08 && trigger > 0.08) {
        setPose(mixerState, 'Fist', Math.max(trigger, squeeze));
      } else if (squeeze > 0.08) {
        setPose(mixerState, 'Grip', squeeze);
      } else if (trigger > 0.08) {
        setPose(mixerState, 'Pinch', trigger);
      } else {
        setPose(mixerState, 'Open', 0);
      }

      // The clips are deliberately paused and scrubbed from analog input. A mixer
      // update still applies the sampled transforms to the skeleton each frame.
      mixerState.mixer.update(dt);
      this.syncObjectGrip(state);
    }
  }

  setVisible(value: boolean): boolean {
    this.visible = value;
    for (const state of this.states) {
      if (state.handAnchor) state.handAnchor.visible = value;
    }
    return this.visible;
  }

  isVisible(): boolean {
    return this.visible;
  }

  get objectGrips(): readonly Group[] {
    return this.states.map((state) => state.objectGrip);
  }

  getIndexTipWorldPosition(handedness: Handedness, target: Vector3): boolean {
    const state = this.states.find((item) => item.handedness === handedness);
    if (!state?.indexTip) return false;
    state.indexTip.updateWorldMatrix(true, false);
    state.indexTip.getWorldPosition(target);
    return true;
  }

  dispose(): void {
    for (const state of this.states) {
      this.detach(state);
      state.controller.removeFromParent();
      state.grip.removeFromParent();
    }
  }
}
