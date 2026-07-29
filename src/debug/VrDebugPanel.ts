import {
  CanvasTexture,
  Group,
  LinearFilter,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  Quaternion,
  SRGBColorSpace,
  Vector3,
} from 'three';
import { formatStats, type DebugStats } from './DebugHud.ts';

const _forward = new Vector3();
const _target = new Vector3();
const _up = new Vector3(0, 1, 0);

/**
 * In-headset debug panel.
 *
 * DOM overlays are invisible inside an immersive session, so the same stats
 * are drawn to a canvas texture on a small quad that trails the head. Hidden
 * by default and toggled with a left thumbstick click, so normal VR use is
 * never cluttered. It follows with deliberate lag - a panel welded to the eyes
 * is uncomfortable to read.
 */
export class VrDebugPanel {
  readonly root = new Group();

  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly texture: CanvasTexture;
  private readonly mesh: Mesh;
  private accumulator = 0;
  private readonly position = new Vector3();
  private readonly quaternion = new Quaternion();
  private placed = false;

  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.width = 512;
    this.canvas.height = 320;
    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('2D canvas context unavailable');
    this.ctx = ctx;

    this.texture = new CanvasTexture(this.canvas);
    this.texture.colorSpace = SRGBColorSpace;
    this.texture.minFilter = LinearFilter;
    this.texture.magFilter = LinearFilter;
    this.texture.generateMipmaps = false;

    this.mesh = new Mesh(
      new PlaneGeometry(0.4, 0.25),
      new MeshBasicMaterial({ map: this.texture, transparent: true, fog: false, depthTest: false }),
    );
    this.mesh.renderOrder = 1000;
    this.mesh.frustumCulled = false;

    this.root.add(this.mesh);
    this.root.visible = false;
    this.root.name = 'vr-debug-panel';
  }

  get visible(): boolean {
    return this.root.visible;
  }

  toggle(): void {
    this.root.visible = !this.root.visible;
    this.placed = false;
  }

  setVisible(visible: boolean): void {
    this.root.visible = visible;
    if (!visible) this.placed = false;
  }

  update(dt: number, headPosition: Vector3, headQuaternion: Quaternion, stats: DebugStats): void {
    if (!this.root.visible) return;

    // Sit below the line of sight, a comfortable arm's length away.
    _forward.set(0, 0, -1).applyQuaternion(headQuaternion);
    _target.copy(headPosition).addScaledVector(_forward, 0.85).addScaledVector(_up, -0.28);

    if (!this.placed) {
      this.position.copy(_target);
      this.quaternion.copy(headQuaternion);
      this.placed = true;
    } else {
      const t = 1 - Math.exp(-6 * dt);
      this.position.lerp(_target, t);
      this.quaternion.slerp(headQuaternion, t);
    }

    this.mesh.position.copy(this.position);
    this.mesh.quaternion.copy(this.quaternion);

    this.accumulator += dt;
    if (this.accumulator < 0.2) return;
    this.accumulator = 0;
    this.draw(stats);
  }

  private draw(stats: DebugStats): void {
    const { ctx, canvas } = this;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = 'rgba(3, 18, 26, 0.82)';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.strokeStyle = 'rgba(120, 200, 220, 0.35)';
    ctx.lineWidth = 2;
    ctx.strokeRect(1, 1, canvas.width - 2, canvas.height - 2);

    ctx.fillStyle = '#cfe8f2';
    ctx.font = '20px ui-monospace, Menlo, Consolas, monospace';
    ctx.textBaseline = 'top';

    const lines = formatStats(stats).split('\n');
    for (let i = 0; i < lines.length; i++) {
      ctx.fillText(lines[i], 16, 14 + i * 29);
    }
    this.texture.needsUpdate = true;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as MeshBasicMaterial).dispose();
    this.texture.dispose();
  }
}
