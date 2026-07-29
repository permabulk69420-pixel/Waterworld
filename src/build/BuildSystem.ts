import {
  BoxHelper,
  BufferGeometry,
  CanvasTexture,
  DoubleSide,
  Group,
  Line,
  LineBasicMaterial,
  Mesh,
  MeshBasicMaterial,
  Object3D,
  PlaneGeometry,
  Quaternion,
  Raycaster,
  Scene,
  Vector3,
  type WebGLRenderer,
} from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone as cloneSkeleton } from 'three/examples/jsm/utils/SkeletonUtils.js';

import type { PlayerRig } from '../player/PlayerRig.ts';
import type { Handedness, VRHands } from '../player/VRHands.ts';

export type GameMode = 'story' | 'build';

type Vec3Tuple = [number, number, number];
type QuatTuple = [number, number, number, number];

interface BuildAssetDefinition {
  id: string;
  label: string;
  url: string;
  scale?: number;
  spawnDistance?: number;
  /** Optional absolute world Y for assets whose origin has semantic meaning, e.g. a ship waterline. */
  spawnY?: number;
}

interface PlacedObjectRecord {
  id: string;
  assetId: string;
  position: Vec3Tuple;
  rotation: QuatTuple;
  scale: Vec3Tuple;
}

interface LayoutFile {
  version: 1;
  objects: PlacedObjectRecord[];
}

interface RuntimeObject {
  record: PlacedObjectRecord;
  root: Object3D;
}

interface PanelButton {
  action: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

const CATALOG_URL = './assets/build/catalog.json';
const PUBLISHED_LAYOUT_URL = './assets/build/world-layout.json';
const LOCAL_LAYOUT_KEY = 'waterworld:buildLayout:v1';
const GRAB_THRESHOLD = 0.55;
const PANEL_WIDTH_PX = 720;
const PANEL_HEIGHT_PX = 920;
const PANEL_WORLD_WIDTH = 0.44;
const PANEL_WORLD_HEIGHT = PANEL_WORLD_WIDTH * (PANEL_HEIGHT_PX / PANEL_WIDTH_PX);

const _origin = new Vector3();
const _direction = new Vector3();
const _head = new Vector3();
const _headQuat = new Quaternion();
const _controllerQuat = new Quaternion();
const _forward = new Vector3();

function vec3Tuple(value: Vector3): Vec3Tuple {
  return [value.x, value.y, value.z];
}

function quatTuple(value: Quaternion): QuatTuple {
  return [value.x, value.y, value.z, value.w];
}

function copyVec3(value: Vec3Tuple): Vec3Tuple {
  return [value[0], value[1], value[2]];
}

function copyQuat(value: QuatTuple): QuatTuple {
  return [value[0], value[1], value[2], value[3]];
}

function newId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `placed-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function isNumberTuple(value: unknown, length: number): value is number[] {
  return Array.isArray(value) && value.length === length && value.every((entry) => typeof entry === 'number');
}

function isPlacedRecord(value: unknown): value is PlacedObjectRecord {
  if (!value || typeof value !== 'object') return false;
  const record = value as Partial<PlacedObjectRecord>;
  return (
    typeof record.id === 'string' &&
    typeof record.assetId === 'string' &&
    isNumberTuple(record.position, 3) &&
    isNumberTuple(record.rotation, 4) &&
    isNumberTuple(record.scale, 3)
  );
}

function isLayoutFile(value: unknown): value is LayoutFile {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<LayoutFile>;
  return candidate.version === 1 && Array.isArray(candidate.objects) && candidate.objects.every(isPlacedRecord);
}

function isAssetCatalog(value: unknown): value is BuildAssetDefinition[] {
  if (!Array.isArray(value)) return false;
  return value.every((item) => {
    if (!item || typeof item !== 'object') return false;
    const asset = item as Partial<BuildAssetDefinition>;
    return typeof asset.id === 'string' && typeof asset.label === 'string' && typeof asset.url === 'string';
  });
}

/**
 * Loads hand-authored world objects in both Story and Build modes.
 *
 * Build mode adds a deliberately small VR editor on top: hold the left trigger
 * to open the panel, point/click with the right trigger, and use either grip to
 * physically move the selected object. The repo remains the source of GLBs;
 * there is intentionally no browser/device file picker.
 */
export class BuildSystem {
  readonly ready: Promise<void>;
  readonly root = new Group();

  private readonly loader = new GLTFLoader();
  private readonly templates = new Map<string, Object3D>();
  private readonly objects = new Map<string, RuntimeObject>();
  private readonly rootToId = new Map<Object3D, string>();
  private readonly raycaster = new Raycaster();

  private catalog: BuildAssetDefinition[] = [];
  private publishedLayout: LayoutFile = { version: 1, objects: [] };
  private assetIndex = 0;
  private selectedId: string | null = null;
  private grabbedId: string | null = null;
  private grabbedBy: Handedness | null = null;

  private readonly selectionBox = new BoxHelper(new Object3D(), 0x65e7ff);

  private readonly panelCanvas = document.createElement('canvas');
  private readonly panelTexture: CanvasTexture;
  private readonly panelMesh: Mesh<PlaneGeometry, MeshBasicMaterial>;
  private readonly panelRoot = new Group();
  private readonly panelButtons: PanelButton[] = [];
  private readonly pointerLine: Line;

  private leftTriggerHeld = false;
  private rightTriggerHeld = false;
  private leftGripHeld = false;
  private rightGripHeld = false;
  private status = 'ready';

  constructor(
    private readonly scene: Scene,
    private readonly renderer: WebGLRenderer,
    private readonly rig: PlayerRig,
    private readonly hands: VRHands,
    readonly mode: GameMode,
  ) {
    this.root.name = 'authored-world';
    scene.add(this.root);

    this.selectionBox.name = 'build-selection-box';
    this.selectionBox.visible = false;
    const boxMaterial = this.selectionBox.material as LineBasicMaterial;
    boxMaterial.depthTest = false;
    boxMaterial.transparent = true;
    boxMaterial.opacity = 0.9;
    this.selectionBox.renderOrder = 999;
    scene.add(this.selectionBox);

    this.panelCanvas.width = PANEL_WIDTH_PX;
    this.panelCanvas.height = PANEL_HEIGHT_PX;
    this.panelTexture = new CanvasTexture(this.panelCanvas);
    const panelMaterial = new MeshBasicMaterial({
      map: this.panelTexture,
      transparent: true,
      side: DoubleSide,
      depthTest: false,
      depthWrite: false,
    });
    this.panelMesh = new Mesh(new PlaneGeometry(PANEL_WORLD_WIDTH, PANEL_WORLD_HEIGHT), panelMaterial);
    this.panelMesh.name = 'build-panel';
    this.panelMesh.renderOrder = 1001;
    this.panelRoot.name = 'build-panel-root';
    this.panelRoot.visible = false;
    this.panelRoot.add(this.panelMesh);
    scene.add(this.panelRoot);

    const pointerGeometry = new BufferGeometry().setFromPoints([
      new Vector3(0, 0, 0),
      new Vector3(0, 0, -3),
    ]);
    const pointerMaterial = new LineBasicMaterial({
      color: 0x70e8ff,
      depthTest: false,
      transparent: true,
      opacity: 0.8,
    });
    this.pointerLine = new Line(pointerGeometry, pointerMaterial);
    this.pointerLine.name = 'build-ui-pointer';
    this.pointerLine.visible = false;
    this.pointerLine.renderOrder = 1002;

    this.ready = this.initialise();
  }

  private async initialise(): Promise<void> {
    const [catalog, published] = await Promise.all([
      this.fetchJson(CATALOG_URL),
      this.fetchJson(PUBLISHED_LAYOUT_URL),
    ]);

    if (isAssetCatalog(catalog)) this.catalog = catalog;
    else console.warn('[build] invalid or missing asset catalog');

    if (isLayoutFile(published)) this.publishedLayout = published;
    else console.warn('[build] invalid or missing published layout');

    await this.loadLayout(this.readLocalLayout() ?? this.publishedLayout);
    this.drawPanel();
  }

  private async fetchJson(url: string): Promise<unknown> {
    try {
      const response = await fetch(url, { cache: 'no-cache' });
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
      return await response.json();
    } catch (error) {
      console.warn(`[build] failed to load ${url}`, error);
      return null;
    }
  }

  private readLocalLayout(): LayoutFile | null {
    try {
      const raw = localStorage.getItem(LOCAL_LAYOUT_KEY);
      if (!raw) return null;
      const parsed: unknown = JSON.parse(raw);
      return isLayoutFile(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  private async loadLayout(layout: LayoutFile): Promise<void> {
    for (const record of layout.objects) await this.createRuntimeObject(record);
  }

  private assetById(assetId: string): BuildAssetDefinition | null {
    return this.catalog.find((asset) => asset.id === assetId) ?? null;
  }

  private async loadTemplate(asset: BuildAssetDefinition): Promise<Object3D> {
    const cached = this.templates.get(asset.id);
    if (cached) return cached;

    const gltf = await this.loader.loadAsync(asset.url);
    const root = gltf.scene;
    root.name = `build-template:${asset.id}`;
    root.traverse((object) => {
      const mesh = object as Mesh;
      if (!mesh.isMesh) return;
      mesh.castShadow = false;
      mesh.receiveShadow = false;
    });
    this.templates.set(asset.id, root);
    return root;
  }

  private async createRuntimeObject(record: PlacedObjectRecord): Promise<RuntimeObject | null> {
    const asset = this.assetById(record.assetId);
    if (!asset) {
      console.warn(`[build] layout references unknown asset ${record.assetId}`);
      return null;
    }

    try {
      const template = await this.loadTemplate(asset);
      const root = cloneSkeleton(template);
      root.name = `placed:${record.assetId}:${record.id}`;
      root.position.fromArray(record.position);
      root.quaternion.fromArray(record.rotation);
      root.scale.fromArray(record.scale);
      this.root.add(root);
      root.updateMatrixWorld(true);

      const runtime: RuntimeObject = { record, root };
      this.objects.set(record.id, runtime);
      this.rootToId.set(root, record.id);
      return runtime;
    } catch (error) {
      console.warn(`[build] failed to instantiate ${asset.url}`, error);
      return null;
    }
  }

  update(): void {
    if (this.mode !== 'build' || !this.renderer.xr.isPresenting) {
      this.panelRoot.visible = false;
      this.pointerLine.visible = false;
      return;
    }

    this.rig.getHeadPosition(_head);
    this.rig.getHeadQuaternion(_headQuat);

    const session = this.renderer.xr.getSession();
    if (!session) return;

    let leftTrigger = false;
    let rightTrigger = false;
    let leftGrip = false;
    let rightGrip = false;

    for (const source of session.inputSources) {
      if (source.handedness !== 'left' && source.handedness !== 'right') continue;
      const gamepad = source.gamepad;
      if (!gamepad) continue;
      const trigger = (gamepad.buttons[0]?.value ?? 0) > 0.55;
      const grip = (gamepad.buttons[1]?.value ?? 0) > GRAB_THRESHOLD;
      if (source.handedness === 'left') {
        leftTrigger = trigger;
        leftGrip = grip;
      } else {
        rightTrigger = trigger;
        rightGrip = grip;
      }
    }

    if (leftTrigger && !this.leftTriggerHeld) this.openPanel();
    this.panelRoot.visible = leftTrigger;
    this.updatePointer(leftTrigger);

    if (rightTrigger && !this.rightTriggerHeld) {
      if (leftTrigger) this.clickPanel();
      else this.selectFromRightRay();
    }

    this.handleGrip('left', leftGrip, this.leftGripHeld);
    this.handleGrip('right', rightGrip, this.rightGripHeld);

    this.leftTriggerHeld = leftTrigger;
    this.rightTriggerHeld = rightTrigger;
    this.leftGripHeld = leftGrip;
    this.rightGripHeld = rightGrip;

    const selected = this.selectedRuntime();
    if (!selected) {
      this.selectionBox.visible = false;
      return;
    }
    this.selectionBox.setFromObject(selected.root);
    this.selectionBox.visible = true;
    this.selectionBox.updateMatrixWorld(true);
  }

  private openPanel(): void {
    _forward.set(0, 0, -1).applyQuaternion(_headQuat);
    _forward.y = 0;
    if (_forward.lengthSq() < 0.001) _forward.set(0, 0, -1);
    _forward.normalize();
    this.panelRoot.position.copy(_head).addScaledVector(_forward, 0.78);
    this.panelRoot.position.y -= 0.12;
    this.panelRoot.lookAt(_head);
    this.panelRoot.updateMatrixWorld(true);
    this.drawPanel();
  }

  private updatePointer(visible: boolean): void {
    const rightGrip = this.hands.getControllerGrip('right');
    if (!visible || !rightGrip) {
      this.pointerLine.visible = false;
      return;
    }
    if (this.pointerLine.parent !== rightGrip) rightGrip.add(this.pointerLine);
    this.pointerLine.visible = true;
  }

  private rayFromHand(handedness: Handedness): boolean {
    const grip = this.hands.getControllerGrip(handedness);
    if (!grip) return false;
    grip.updateWorldMatrix(true, false);
    grip.getWorldPosition(_origin);
    grip.getWorldQuaternion(_controllerQuat);
    _direction.set(0, 0, -1).applyQuaternion(_controllerQuat).normalize();
    this.raycaster.set(_origin, _direction);
    this.raycaster.far = 80;
    return true;
  }

  private clickPanel(): void {
    if (!this.rayFromHand('right')) return;
    const hit = this.raycaster.intersectObject(this.panelMesh, false)[0];
    if (!hit?.uv) return;
    const x = hit.uv.x * PANEL_WIDTH_PX;
    const y = (1 - hit.uv.y) * PANEL_HEIGHT_PX;
    const button = this.panelButtons.find(
      (candidate) =>
        x >= candidate.x &&
        x <= candidate.x + candidate.w &&
        y >= candidate.y &&
        y <= candidate.y + candidate.h,
    );
    if (button) this.runPanelAction(button.action);
  }

  private selectFromRightRay(): void {
    if (!this.rayFromHand('right')) return;
    const roots = [...this.objects.values()].map((runtime) => runtime.root);
    const hits = this.raycaster.intersectObjects(roots, true);
    for (const hit of hits) {
      const runtime = this.runtimeForDescendant(hit.object);
      if (!runtime) continue;
      this.select(runtime.record.id);
      return;
    }
    this.select(null);
  }

  private runtimeForDescendant(object: Object3D): RuntimeObject | null {
    let current: Object3D | null = object;
    while (current) {
      const id = this.rootToId.get(current);
      if (id) return this.objects.get(id) ?? null;
      current = current.parent;
    }
    return null;
  }

  private handleGrip(handedness: Handedness, held: boolean, wasHeld: boolean): void {
    if (held && !wasHeld) this.beginGrab(handedness);
    if (!held && wasHeld && this.grabbedBy === handedness) this.endGrab();
  }

  private beginGrab(handedness: Handedness): void {
    if (this.grabbedId || !this.selectedId) return;
    const runtime = this.objects.get(this.selectedId);
    const grip = this.hands.getObjectGrip(handedness);
    if (!runtime || !grip) return;
    grip.attach(runtime.root);
    runtime.root.updateMatrixWorld(true);
    this.grabbedId = runtime.record.id;
    this.grabbedBy = handedness;
    this.status = `moving ${this.assetById(runtime.record.assetId)?.label ?? runtime.record.assetId}`;
    this.drawPanel();
  }

  private endGrab(): void {
    if (!this.grabbedId) return;
    const runtime = this.objects.get(this.grabbedId);
    if (runtime) {
      this.root.attach(runtime.root);
      runtime.root.updateMatrixWorld(true);
      this.syncRecord(runtime);
      this.saveLocalLayout();
    }
    this.grabbedId = null;
    this.grabbedBy = null;
    this.status = 'saved';
    this.drawPanel();
  }

  private select(id: string | null): void {
    this.selectedId = id;
    this.status = id ? 'selected' : 'nothing selected';
    this.drawPanel();
  }

  private selectedRuntime(): RuntimeObject | null {
    return this.selectedId ? this.objects.get(this.selectedId) ?? null : null;
  }

  private runPanelAction(action: string): void {
    switch (action) {
      case 'asset-prev':
        if (this.catalog.length > 0) this.assetIndex = (this.assetIndex - 1 + this.catalog.length) % this.catalog.length;
        this.status = 'asset changed';
        this.drawPanel();
        break;
      case 'asset-next':
        if (this.catalog.length > 0) this.assetIndex = (this.assetIndex + 1) % this.catalog.length;
        this.status = 'asset changed';
        this.drawPanel();
        break;
      case 'spawn':
        void this.spawnSelectedAsset();
        break;
      case 'rotate-left':
        this.rotateSelected(-15);
        break;
      case 'rotate-right':
        this.rotateSelected(15);
        break;
      case 'scale-down':
        this.scaleSelected(0.8);
        break;
      case 'scale-up':
        this.scaleSelected(1.25);
        break;
      case 'duplicate':
        void this.duplicateSelected();
        break;
      case 'delete':
        this.deleteSelected();
        break;
      case 'copy':
        void this.copyLayout();
        break;
      case 'reset':
        void this.resetToPublished();
        break;
    }
  }

  private async spawnSelectedAsset(): Promise<void> {
    const asset = this.catalog[this.assetIndex];
    if (!asset) {
      this.status = 'catalog is empty';
      this.drawPanel();
      return;
    }

    this.status = `loading ${asset.label}`;
    this.drawPanel();

    _forward.set(0, 0, -1).applyQuaternion(_headQuat);
    if (_forward.lengthSq() < 0.001) _forward.set(0, 0, -1);
    _forward.normalize();
    const position = _head.clone().addScaledVector(_forward, asset.spawnDistance ?? 2.2);
    if (asset.spawnY !== undefined) position.y = asset.spawnY;
    const uniformScale = asset.scale ?? 1;
    const record: PlacedObjectRecord = {
      id: newId(),
      assetId: asset.id,
      position: vec3Tuple(position),
      rotation: [0, 0, 0, 1],
      scale: [uniformScale, uniformScale, uniformScale],
    };

    const runtime = await this.createRuntimeObject(record);
    if (!runtime) {
      this.status = `failed: ${asset.label}`;
      this.drawPanel();
      return;
    }
    this.select(runtime.record.id);
    this.status = `spawned ${asset.label}`;
    this.saveLocalLayout();
    this.drawPanel();
  }

  private rotateSelected(degrees: number): void {
    const runtime = this.selectedRuntime();
    if (!runtime || this.grabbedId) return;
    runtime.root.rotateY((degrees * Math.PI) / 180);
    runtime.root.updateMatrixWorld(true);
    this.syncRecord(runtime);
    this.saveLocalLayout();
    this.status = `${degrees > 0 ? '+' : ''}${degrees}°`;
    this.drawPanel();
  }

  private scaleSelected(multiplier: number): void {
    const runtime = this.selectedRuntime();
    if (!runtime || this.grabbedId) return;
    runtime.root.scale.multiplyScalar(multiplier);
    const maxAxis = Math.max(runtime.root.scale.x, runtime.root.scale.y, runtime.root.scale.z);
    const minAxis = Math.min(runtime.root.scale.x, runtime.root.scale.y, runtime.root.scale.z);
    if (maxAxis > 25 || minAxis < 0.02) runtime.root.scale.multiplyScalar(1 / multiplier);
    runtime.root.updateMatrixWorld(true);
    this.syncRecord(runtime);
    this.saveLocalLayout();
    this.status = `scale ${runtime.root.scale.x.toFixed(2)}×`;
    this.drawPanel();
  }

  private async duplicateSelected(): Promise<void> {
    const runtime = this.selectedRuntime();
    if (!runtime || this.grabbedId) return;
    this.syncRecord(runtime);
    const record: PlacedObjectRecord = {
      id: newId(),
      assetId: runtime.record.assetId,
      position: [runtime.record.position[0] + 0.6, runtime.record.position[1], runtime.record.position[2]],
      rotation: copyQuat(runtime.record.rotation),
      scale: copyVec3(runtime.record.scale),
    };
    const copy = await this.createRuntimeObject(record);
    if (!copy) return;
    this.select(copy.record.id);
    this.saveLocalLayout();
    this.status = 'duplicated';
    this.drawPanel();
  }

  private deleteSelected(): void {
    const runtime = this.selectedRuntime();
    if (!runtime || this.grabbedId === runtime.record.id) return;
    runtime.root.removeFromParent();
    this.rootToId.delete(runtime.root);
    this.objects.delete(runtime.record.id);
    this.selectedId = null;
    this.selectionBox.visible = false;
    this.saveLocalLayout();
    this.status = 'deleted';
    this.drawPanel();
  }

  private syncRecord(runtime: RuntimeObject): void {
    runtime.record.position = vec3Tuple(runtime.root.position);
    runtime.record.rotation = quatTuple(runtime.root.quaternion);
    runtime.record.scale = vec3Tuple(runtime.root.scale);
  }

  private currentLayout(): LayoutFile {
    const records: PlacedObjectRecord[] = [];
    for (const runtime of this.objects.values()) {
      if (runtime.record.id !== this.grabbedId) this.syncRecord(runtime);
      records.push({
        id: runtime.record.id,
        assetId: runtime.record.assetId,
        position: copyVec3(runtime.record.position),
        rotation: copyQuat(runtime.record.rotation),
        scale: copyVec3(runtime.record.scale),
      });
    }
    return { version: 1, objects: records };
  }

  private saveLocalLayout(): void {
    try {
      localStorage.setItem(LOCAL_LAYOUT_KEY, JSON.stringify(this.currentLayout()));
    } catch {
      this.status = 'local save unavailable';
    }
  }

  private async copyLayout(): Promise<void> {
    const text = JSON.stringify(this.currentLayout(), null, 2);
    try {
      await navigator.clipboard.writeText(text);
      this.status = 'layout copied — paste it into chat';
    } catch {
      console.log('[build] layout JSON\n', text);
      this.status = 'clipboard blocked — layout printed to console';
    }
    this.drawPanel();
  }

  private async resetToPublished(): Promise<void> {
    if (this.grabbedId) this.endGrab();
    for (const runtime of this.objects.values()) runtime.root.removeFromParent();
    this.objects.clear();
    this.rootToId.clear();
    this.selectedId = null;
    try {
      localStorage.removeItem(LOCAL_LAYOUT_KEY);
    } catch {
      // Ignore restricted storage; published layout still reloads for this session.
    }
    await this.loadLayout(this.publishedLayout);
    this.status = 'reset to GitHub layout';
    this.drawPanel();
  }

  private drawPanel(): void {
    const ctx = this.panelCanvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, PANEL_WIDTH_PX, PANEL_HEIGHT_PX);
    ctx.fillStyle = 'rgba(3, 16, 22, 0.94)';
    ctx.fillRect(0, 0, PANEL_WIDTH_PX, PANEL_HEIGHT_PX);
    ctx.strokeStyle = 'rgba(100, 231, 255, 0.85)';
    ctx.lineWidth = 4;
    ctx.strokeRect(8, 8, PANEL_WIDTH_PX - 16, PANEL_HEIGHT_PX - 16);

    ctx.fillStyle = '#dff9ff';
    ctx.font = '700 38px monospace';
    ctx.fillText('BUILD MODE', 34, 58);
    ctx.font = '22px monospace';
    ctx.fillStyle = '#83dbea';
    ctx.fillText('Hold LEFT trigger to keep this panel open', 34, 98);
    ctx.fillText('RIGHT trigger: click / select   GRIP: move selection', 34, 132);

    const asset = this.catalog[this.assetIndex];
    const selected = this.selectedRuntime();
    ctx.fillStyle = '#dff9ff';
    ctx.font = '26px monospace';
    ctx.fillText(`Asset: ${asset?.label ?? '(catalog empty)'}`, 34, 190);
    ctx.fillText(
      `Selected: ${selected ? this.assetById(selected.record.assetId)?.label ?? selected.record.assetId : '(none)'}`,
      34,
      228,
    );
    ctx.font = '20px monospace';
    ctx.fillStyle = '#8fb8c1';
    ctx.fillText(`Objects: ${this.objects.size}   ${this.status}`, 34, 266);

    this.panelButtons.length = 0;
    const gap = 14;
    const left = 34;
    const full = PANEL_WIDTH_PX - left * 2;
    const third = (full - gap * 2) / 3;
    const half = (full - gap) / 2;
    const h = 74;
    let y = 310;

    this.addPanelButton(ctx, '< ASSET', 'asset-prev', left, y, third, h);
    this.addPanelButton(ctx, 'SPAWN', 'spawn', left + third + gap, y, third, h);
    this.addPanelButton(ctx, 'ASSET >', 'asset-next', left + (third + gap) * 2, y, third, h);
    y += h + gap;

    this.addPanelButton(ctx, 'ROT -15°', 'rotate-left', left, y, half, h);
    this.addPanelButton(ctx, 'ROT +15°', 'rotate-right', left + half + gap, y, half, h);
    y += h + gap;

    this.addPanelButton(ctx, 'SCALE -', 'scale-down', left, y, half, h);
    this.addPanelButton(ctx, 'SCALE +', 'scale-up', left + half + gap, y, half, h);
    y += h + gap;

    this.addPanelButton(ctx, 'DUPLICATE', 'duplicate', left, y, half, h);
    this.addPanelButton(ctx, 'DELETE', 'delete', left + half + gap, y, half, h, true);
    y += h + gap;

    this.addPanelButton(ctx, 'COPY LAYOUT JSON', 'copy', left, y, full, h);
    y += h + gap;
    this.addPanelButton(ctx, 'RESET TO GITHUB LAYOUT', 'reset', left, y, full, h, true);

    ctx.font = '18px monospace';
    ctx.fillStyle = '#658993';
    ctx.fillText('GLBs come from public/assets via catalog.json — no device importing.', 34, PANEL_HEIGHT_PX - 34);
    this.panelTexture.needsUpdate = true;
  }

  private addPanelButton(
    ctx: CanvasRenderingContext2D,
    label: string,
    action: string,
    x: number,
    y: number,
    w: number,
    h: number,
    danger = false,
  ): void {
    this.panelButtons.push({ action, x, y, w, h });
    ctx.fillStyle = danger ? 'rgba(126, 42, 48, 0.72)' : 'rgba(25, 91, 106, 0.72)';
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = danger ? '#d77a80' : '#63d7ec';
    ctx.lineWidth = 2;
    ctx.strokeRect(x, y, w, h);
    ctx.fillStyle = '#e7fbff';
    ctx.font = '700 22px monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, x + w / 2, y + h / 2);
    ctx.textAlign = 'start';
    ctx.textBaseline = 'alphabetic';
  }

  dispose(): void {
    if (this.grabbedId) this.endGrab();
    this.root.removeFromParent();
    this.selectionBox.removeFromParent();
    this.selectionBox.geometry.dispose();
    (this.selectionBox.material as LineBasicMaterial).dispose();
    this.panelRoot.removeFromParent();
    this.panelMesh.geometry.dispose();
    this.panelMesh.material.dispose();
    this.panelTexture.dispose();
    this.pointerLine.removeFromParent();
    this.pointerLine.geometry.dispose();
    (this.pointerLine.material as LineBasicMaterial).dispose();
  }
}
