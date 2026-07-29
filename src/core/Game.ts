import {
  ACESFilmicToneMapping,
  type MeshStandardMaterial,
  PerspectiveCamera,
  Quaternion,
  Scene,
  Vector3,
  WebGLRenderer,
} from 'three';
import { VRButton } from 'three/examples/jsm/webxr/VRButton.js';

import { DEFAULT_WORLD_CONFIG, type WorldConfig } from '../config/worldConfig.ts';
import { createDefaultBiomeRegistry } from '../config/biomes/index.ts';
import { DensityField } from '../world/density.ts';
import { ChunkManager } from '../world/ChunkManager.ts';
import { CollisionWorld } from '../physics/CollisionWorld.ts';
import { ContentRegistry } from '../content/ContentRegistry.ts';
import { Environment } from '../environment/Environment.ts';
import { createTerrainMaterial, disposeTerrainMaterial } from '../environment/TerrainMaterial.ts';
import { PlayerRig } from '../player/PlayerRig.ts';
import { Locomotion } from '../player/Locomotion.ts';
import { XRInput } from '../player/XRInput.ts';
import { DesktopInput } from '../player/DesktopInput.ts';
import { DEFAULT_PLAYER_CONFIG, type PlayerConfig } from '../player/playerConfig.ts';
import type { MoveIntent } from '../player/inputTypes.ts';
import { DebugHud, type DebugStats } from '../debug/DebugHud.ts';
import { DebugOverlays } from '../debug/DebugOverlays.ts';
import { VrDebugPanel } from '../debug/VrDebugPanel.ts';
import { clamp } from '../math/mathUtils.ts';
import { FrameTimer } from './FrameTimer.ts';

export interface GameOptions {
  world?: Partial<WorldConfig>;
  player?: Partial<PlayerConfig>;
  /** Show the debug HUD from the start. */
  debug?: boolean;
}

export type GameFrameListener = (dt: number, elapsed: number) => void;

const _head = new Vector3();
const _headQuat = new Quaternion();
const _rescue = new Vector3();

/**
 * Application root: owns the renderer and the frame loop, and wires the
 * world, environment, player and debug systems together. Everything it
 * depends on is constructor-injected data or a self-contained system, so a
 * later pass can swap any one of them without unpicking this file.
 */
export class Game {
  readonly renderer: WebGLRenderer;
  readonly scene = new Scene();
  readonly camera: PerspectiveCamera;

  readonly worldConfig: WorldConfig;
  readonly playerConfig: PlayerConfig;

  readonly biomes = createDefaultBiomeRegistry();
  readonly density: DensityField;
  readonly collision = new CollisionWorld();
  readonly content: ContentRegistry;
  readonly chunks: ChunkManager;
  readonly environment: Environment;

  readonly rig: PlayerRig;
  readonly locomotion: Locomotion;
  readonly xrInput: XRInput;
  readonly desktopInput: DesktopInput;

  private readonly hud: DebugHud;
  private readonly overlays: DebugOverlays;
  private readonly vrPanel: VrDebugPanel;

  private readonly timer = new FrameTimer();
  private readonly terrainMaterial: MeshStandardMaterial;
  private readonly frameListeners = new Set<GameFrameListener>();
  private stuckTime = 0;
  private fps = 60;
  private frameMs = 16;
  private started = false;

  constructor(container: HTMLElement, hudElement: HTMLElement, options: GameOptions = {}) {
    this.worldConfig = { ...DEFAULT_WORLD_CONFIG, ...options.world };
    this.playerConfig = { ...DEFAULT_PLAYER_CONFIG, ...options.player };

    // --- renderer --------------------------------------------------------
    this.renderer = new WebGLRenderer({
      antialias: true,
      powerPreference: 'high-performance',
      // Depth precision matters more than stencil for a world this size.
      stencil: false,
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.toneMapping = ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.shadowMap.enabled = false;
    this.renderer.xr.enabled = true;
    container.appendChild(this.renderer.domElement);

    // Fixed foveation trades peripheral sharpness for fill rate - the single
    // biggest free win on standalone Quest.
    this.renderer.xr.setFoveation(0.5);

    document.body.appendChild(VRButton.createButton(this.renderer));

    // --- camera / player rig ---------------------------------------------
    this.camera = new PerspectiveCamera(72, window.innerWidth / window.innerHeight, 0.1, 4200);
    // Matches the 'local-floor' reference space used in XR, so the desktop
    // fallback puts the eyes at the same height above the rig origin.
    this.camera.position.set(0, 1.6, 0);
    this.rig = new PlayerRig(this.camera, this.renderer);
    this.scene.add(this.rig.group);

    // --- world -----------------------------------------------------------
    this.density = new DensityField(this.worldConfig.seed, this.biomes);
    this.content = new ContentRegistry(this.density, this.worldConfig.seed);

    this.terrainMaterial = createTerrainMaterial(this.renderer, this.worldConfig.seaLevel);

    this.chunks = new ChunkManager(
      this.worldConfig,
      this.biomes,
      this.density,
      this.terrainMaterial,
      this.collision,
      this.content,
      this.scene,
    );

    this.environment = new Environment(this.scene, this.worldConfig, this.biomes);

    // --- player ----------------------------------------------------------
    this.locomotion = new Locomotion(this.rig, this.collision, this.playerConfig);
    this.xrInput = new XRInput(this.renderer, this.playerConfig);
    this.desktopInput = new DesktopInput(this.renderer.domElement, this.camera);

    // --- debug -----------------------------------------------------------
    this.hud = new DebugHud(hudElement);
    this.overlays = new DebugOverlays(this.worldConfig, this.scene);
    this.vrPanel = new VrDebugPanel();
    this.rig.group.add(this.vrPanel.root);
    if (options.debug) this.hud.setVisible(true);

    this.desktopInput.onToggleDebug = () => this.hud.toggle();
    this.desktopInput.onToggleChunkBounds = () => this.overlays.toggleChunkBounds();
    this.desktopInput.onToggleCollisionVolume = () => this.overlays.toggleCapsule();

    window.addEventListener('resize', () => this.onResize());
    this.renderer.xr.addEventListener('sessionend', () => this.onResize());
  }

  /**
   * Adds a lightweight per-frame system to the same authoritative Three/WebXR
   * animation loop as locomotion and rendering. Returns an unsubscribe callback.
   */
  addFrameListener(listener: GameFrameListener): () => void {
    this.frameListeners.add(listener);
    return () => this.frameListeners.delete(listener);
  }

  /**
   * Generates the starting chunks, places the player and starts the loop.
   * @param onProgress 0..1
   */
  async start(onProgress?: (progress: number, label: string) => void): Promise<void> {
    if (this.started) return;
    this.started = true;

    const spawn = this.findSpawn();
    this.rig.group.position.set(spawn.x, spawn.y - 1.6, spawn.z);
    this.rig.group.updateMatrixWorld(true);

    this.chunks.onProgress = (loaded, total) => {
      onProgress?.(clamp(loaded / total, 0, 1), `terrain ${loaded}/${total}`);
    };

    onProgress?.(0, 'generating terrain');
    await this.chunks.preload(spawn);

    // Spawn may have landed inside an overhang or a landmark; push out.
    this.locomotion.settle();
    onProgress?.(1, 'ready');

    this.timer.start();
    this.renderer.setAnimationLoop(() => this.frame());
  }

  /**
   * Picks a start position: in open water above the seabed at the world
   * origin, clear of the surface chop.
   */
  private findSpawn(): Vector3 {
    const { spawn, seaLevel } = this.worldConfig;
    const seabed = this.density.seabedAt(spawn.x, spawn.z);
    // Hover a few metres over the seabed but stay clear of the surface chop.
    const y = clamp(Math.max(spawn.y, seabed + 5), this.worldConfig.worldMinY + 4, seaLevel - 3);
    return new Vector3(spawn.x, y, spawn.z);
  }

  private frame(): void {
    const dt = this.timer.tick();
    const elapsed = this.timer.elapsed;
    if (dt > 0) {
      const instant = 1 / dt;
      this.fps += (instant - this.fps) * 0.08;
      this.frameMs += (dt * 1000 - this.frameMs) * 0.08;
    }

    const presenting = this.renderer.xr.isPresenting;

    // --- input -----------------------------------------------------------
    let extraYaw = 0;
    let intent: MoveIntent;
    if (presenting) {
      intent = this.xrInput.poll();
      if (this.xrInput.debugTogglePressed) this.vrPanel.toggle();
    } else {
      this.desktopInput.applyCameraPitch();
      intent = this.desktopInput.poll(true);
      extraYaw = this.desktopInput.consumeYawDelta();
    }

    // External player systems (hands, held props, propulsion) run here so they
    // see the same XR pose and can update locomotion input before simulation.
    for (const listener of this.frameListeners) listener(dt, elapsed);

    // --- simulate --------------------------------------------------------
    // Locomotion uses the exact same animated wave height as the ocean shader.
    // Underwater movement therefore stops at the visible surface instead of
    // continuing upward through it as unrestricted flight.
    this.rig.getHeadPosition(_head);
    const surfaceY = this.environment.ocean.heightAt(_head.x, _head.z, elapsed);
    this.locomotion.update(dt, intent, extraYaw, surfaceY);

    this.rig.getHeadPosition(_head);
    this.rig.getHeadQuaternion(_headQuat);
    this.recoverIfStuck(dt);

    this.chunks.update(_head);
    this.environment.update(_head, elapsed);

    // Runtime content gets the same authoritative player position once per game
    // frame. Small vegetation can therefore use a much shorter distance than the
    // terrain streamer without running a second animation loop.
    this.content.update(dt, _head);

    // --- debug -----------------------------------------------------------
    const stats = this.collectStats(presenting);
    this.hud.update(dt, stats);
    this.vrPanel.update(dt, _head, _headQuat, stats);
    this.overlays.update(this.loadedChunkKeys(), this.locomotion.capsule);

    this.renderer.render(this.scene, this.camera);
  }

  /**
   * Safety net for the one case triangle collision cannot dig itself out of.
   *
   * The solver ignores faces the capsule is already more than a radius behind,
   * which is what stops it ejecting the player through thin cave walls - but
   * it also means a player who somehow ends up fully embedded (a physical
   * roomscale step into a wall, a chunk streaming in around them) has nothing
   * to push against. Sampling the density field directly costs one call per
   * frame and gives an unambiguous answer, so lift them to the nearest open
   * water rather than letting them sink.
   */
  private recoverIfStuck(dt: number): void {
    if (this.density.sample(_head.x, _head.y, _head.z) <= 0) {
      this.stuckTime = 0;
      return;
    }

    this.stuckTime += dt;
    if (this.stuckTime < 0.35) return;
    this.stuckTime = 0;

    const open = this.density.firstOpenAbove(_head.x, _head.y, _head.z, 60);
    if (open === null) return;
    _rescue.set(_head.x, open + this.playerConfig.bodyRadius + 0.3, _head.z);
    this.locomotion.teleport(_rescue);
    this.rig.getHeadPosition(_head);
    console.warn('[player] recovered from terrain at', _rescue.toArray());
  }

  private *loadedChunkKeys(): Generator<string> {
    // Only used when the chunk-bounds overlay is on.
    if (!this.overlays.chunkBoundsVisible) return;
    const r = this.worldConfig.viewDistanceChunks;
    const { cx, cz } = this.chunks.chunkAt(_head.x, _head.z);
    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        if (dx * dx + dz * dz > (r + 0.5) * (r + 0.5)) continue;
        yield `${cx + dx},${cz + dz}`;
      }
    }
  }

  private collectStats(presenting: boolean): DebugStats {
    const chunkStats = this.chunks.stats;
    const { cx, cz } = this.chunks.chunkAt(_head.x, _head.z);
    return {
      fps: this.fps,
      frameMs: this.frameMs,
      position: { x: _head.x, y: _head.y, z: _head.z },
      depth: this.environment.depth,
      biome: this.biomes.biomeAt(_head.x, _head.z).id,
      chunk: { cx, cz },
      chunksLoaded: chunkStats.loaded,
      chunksPending: chunkStats.pending,
      chunksQueued: chunkStats.queued,
      triangles: chunkStats.triangles,
      drawCalls: this.renderer.info.render.calls,
      generateMs: chunkStats.lastGenerateMs,
      workers: chunkStats.usingWorkers,
      speed: this.locomotion.state.speed,
      contacts: this.locomotion.state.contacts,
      colliderMb: chunkStats.colliderBytes / (1024 * 1024),
      underwater: this.environment.underwater,
      mode: presenting ? 'vr' : 'desktop',
    };
  }

  private onResize(): void {
    const width = window.innerWidth;
    const height = window.innerHeight;
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height);
  }

  dispose(): void {
    this.renderer.setAnimationLoop(null);
    this.frameListeners.clear();
    this.chunks.dispose();
    this.environment.dispose();
    this.overlays.dispose();
    this.vrPanel.dispose();
    this.desktopInput.dispose();
    disposeTerrainMaterial(this.terrainMaterial);
    this.renderer.dispose();
  }
}
