import { installBuildSelectionAssist } from './build/BuildSelectionAssist.ts';
import { BuildSystem } from './build/BuildSystem.ts';
import { Game } from './core/Game.ts';
import { DEFAULT_WORLD_CONFIG } from './config/worldConfig.ts';
import { OctopusCrabSystem } from './content/OctopusCrabSystem.ts';
import { PrismFishSystem } from './content/PrismFishSystem.ts';
import { SeaGrassSystem } from './content/SeaGrassSystem.ts';
import { SnapBulbSystem } from './content/SnapBulbSystem.ts';
import { BioluminescentPlankton } from './environment/BioluminescentPlankton.ts';
import { HandThrusters } from './player/HandThrusters.ts';
import { Headlamp } from './player/Headlamp.ts';
import { RearLedgeClimb } from './player/RearLedgeClimb.ts';
import { ThrusterLightingFix } from './player/ThrusterLightingFix.ts';
import { VRHands } from './player/VRHands.ts';
import { BootSettings } from './ui/BootSettings.ts';
import { installShipCollision } from './world/ShipCollisionSystem.ts';

const BUILD_TAG = 'BUILD-MODE-V12-PHYSICAL-SNAP-BULBS';

/**
 * Bootstrap.
 *
 * URL parameters (all optional):
 *   ?seed=12345         world seed
 *   ?mode=build         launch Build mode directly
 *   ?debug=1            start with the debug HUD visible
 *   ?view=4             initial terrain load-distance slider value
 *   ?grassDensity=100   initial grass density percentage
 *   ?grassDistance=46   initial grass render distance in metres
 *   ?workers=0          force main-thread terrain generation
 */
const params = new URLSearchParams(location.search);
const number = (key: string): number | undefined => {
  const raw = params.get(key);
  if (raw === null) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
};

const boot = document.getElementById('boot')!;
const bootFill = document.getElementById('boot-fill')!;
const hint = document.getElementById('hint')!;
const hudElement = document.getElementById('debug-hud')!;
const settings = new BootSettings(
  number('view'),
  number('grassDensity'),
  number('grassDistance'),
  params.get('mode'),
);
settings.setStatus(`${BUILD_TAG} · choose mode and performance settings`);

async function bootstrap(): Promise<void> {
  const {
    mode,
    viewDistanceChunks,
    grassDensityPercent,
    grassRenderDistance,
  } = await settings.waitForStart();

  const baseBounds = DEFAULT_WORLD_CONFIG.playableBounds;
  const playableBounds = baseBounds
    ? {
        halfChunksX: Math.max(baseBounds.halfChunksX, viewDistanceChunks),
        halfChunksZ: Math.max(baseBounds.halfChunksZ, viewDistanceChunks),
      }
    : null;

  const game = new Game(document.body, hudElement, {
    debug: params.get('debug') === '1',
    world: {
      ...(number('seed') !== undefined ? { seed: number('seed')! } : {}),
      viewDistanceChunks,
      playableBounds,
      ...(number('workers') !== undefined ? { workerCount: number('workers')! } : {}),
    },
  });

  const seaGrass = new SeaGrassSystem(game.scene, {
    densityMultiplier: grassDensityPercent / 100,
    renderDistance: grassRenderDistance,
  });
  game.content.register(seaGrass);
  settings.setStatus(`${BUILD_TAG} · loading shallow vegetation`);
  await seaGrass.ready;

  const prismFish = new PrismFishSystem(
    game.scene,
    game.density,
    game.biomes,
    game.environment,
    game.rig,
  );
  settings.setStatus(`${BUILD_TAG} · loading prism fish`);
  await prismFish.ready;

  const octopusCrabs = new OctopusCrabSystem(
    game.scene,
    game.density,
    game.biomes,
    game.environment,
    game.rig,
  );
  settings.setStatus(`${BUILD_TAG} · loading octopus crabs`);
  await octopusCrabs.ready;

  const hands = new VRHands(game.renderer, game.rig.group);
  settings.setStatus(`${BUILD_TAG} · loading VR hands`);
  await hands.ready;

  const plankton = new BioluminescentPlankton(
    game.scene,
    game.environment,
    game.rig,
    hands,
    game.locomotion,
  );

  const authoredWorld = new BuildSystem(game.scene, game.renderer, game.rig, hands, mode);
  settings.setStatus(`${BUILD_TAG} · loading authored world`);
  await authoredWorld.ready;
  installBuildSelectionAssist(authoredWorld);

  const snapBulbs = new SnapBulbSystem(authoredWorld.root, game.renderer, hands, mode);
  settings.setStatus(`${BUILD_TAG} · loading snap bulbs`);
  await snapBulbs.ready;

  let thrusters: HandThrusters | null = null;
  let thrusterLighting: ThrusterLightingFix | null = null;
  let rearClimb: RearLedgeClimb | null = null;
  let headlamp: Headlamp | null = null;
  if (mode === 'story') {
    // The ship GLB carries simple COLLIDER_* geometry for its accessible rear
    // section. Install it only in Story mode so Build-mode object movement never
    // leaves stale static collision behind.
    installShipCollision(game.scene, game.collision);

    rearClimb = new RearLedgeClimb(
      game.scene,
      game.renderer,
      game.rig,
      hands,
      game.locomotion,
    );

    headlamp = new Headlamp(game.scene, game.renderer, game.rig, hands);
    // Give the current test lamp roughly 30% more practical reach without changing
    // beam width or battery behaviour.
    headlamp.light.distance *= 1.3;
    headlamp.light.intensity *= 1.3;

    thrusters = new HandThrusters(
      game.renderer,
      hands,
      game.locomotion,
      game.scene,
      game.rig,
    );
    thrusterLighting = new ThrusterLightingFix(game.scene);
    settings.setStatus(`${BUILD_TAG} · loading hand motors`);
    await thrusters.ready;
  }

  // Story reserves triggers for the motors. Build reserves them for the editor.
  // Vertical travel in Build stays on A/X and B/Y, so there is no input fight.
  game.xrInput.setTriggerVerticalEnabled(false);

  game.addFrameListener((dt, elapsed) => {
    hands.update(dt);
    headlamp?.update(dt);
    thrusters?.update(dt);
    // Spawned motors used to be unlit MeshBasicMaterial. Convert each new pickup
    // once so it now darkens naturally with the rest of the underwater scene.
    thrusterLighting?.update();
    prismFish.update(dt, elapsed);
    octopusCrabs.update(dt);
    plankton.update(dt, elapsed);
    // Run after the motors so an anchored hand can cancel propulsion for the
    // current frame while the player physically pulls against the rear ledge.
    rearClimb?.update();
    authoredWorld.update();
    snapBulbs.update(dt);
  });

  (window as unknown as {
    game: Game;
    build: BuildSystem;
    headlamp: Headlamp | null;
    plankton: BioluminescentPlankton;
  }).game = game;
  (window as unknown as {
    game: Game;
    build: BuildSystem;
    headlamp: Headlamp | null;
    plankton: BioluminescentPlankton;
  }).build = authoredWorld;
  (window as unknown as {
    game: Game;
    build: BuildSystem;
    headlamp: Headlamp | null;
    plankton: BioluminescentPlankton;
  }).headlamp = headlamp;
  (window as unknown as {
    game: Game;
    build: BuildSystem;
    headlamp: Headlamp | null;
    plankton: BioluminescentPlankton;
  }).plankton = plankton;
  (window as unknown as { snapBulbs: SnapBulbSystem }).snapBulbs = snapBulbs;

  await game.start((progress, label) => {
    bootFill.style.width = `${Math.round(progress * 100)}%`;
    settings.setStatus(`${BUILD_TAG} · ${mode.toUpperCase()} · ${label}`);
  });

  if (mode === 'build') {
    hint.textContent = 'BUILD · right-hand laser aims · right trigger selects · right grip grabs pointed prop · left trigger menu · A/X up · B/Y down';
  } else {
    hint.textContent = 'STORY · tap either side of your head with a hand to toggle lamp · rear ledge: hold grip and pull';
  }

  boot.classList.add('hidden');
  setTimeout(() => boot.remove(), 800);
  setTimeout(() => hint.classList.add('faded'), mode === 'build' ? 16000 : 9000);
}

bootstrap().catch((error: unknown) => {
  console.error(error);
  settings.setStatus(`${BUILD_TAG} · failed: ${error instanceof Error ? error.message : String(error)}`);
});
