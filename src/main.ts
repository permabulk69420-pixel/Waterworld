import { installBuildSelectionAssist } from './build/BuildSelectionAssist.ts';
import { BuildSystem } from './build/BuildSystem.ts';
import { Game } from './core/Game.ts';
import { DEFAULT_WORLD_CONFIG } from './config/worldConfig.ts';
import { AlienFishSystem } from './content/AlienFishSystem.ts';
import { ColossusMushroomSystem } from './content/ColossusMushroomSystem.ts';
import { FruitMushroomSystem } from './content/FruitMushroomSystem.ts';
import { GiantMushroomSystem } from './content/GiantMushroomSystem.ts';
import { OctopusCrabSystem } from './content/OctopusCrabSystem.ts';
import { PrismFishSystem } from './content/PrismFishSystem.ts';
import { RiftmawHunterSystem } from './content/RiftmawHunterSystem.ts';
import { RiverRockSystem } from './content/RiverRockSystem.ts';
import { SeaGrassSystem } from './content/SeaGrassSystem.ts';
import { SnapBulbSystem } from './content/SnapBulbSystem.ts';
import { BioluminescentPlankton } from './environment/BioluminescentPlankton.ts';
import { HandThrusters } from './player/HandThrusters.ts';
import { Headlamp } from './player/Headlamp.ts';
import { RearLedgeClimb } from './player/RearLedgeClimb.ts';
import { SpeargunSystem } from './player/SpeargunSystem.ts';
import { ThrusterLightingFix } from './player/ThrusterLightingFix.ts';
import { VRHands } from './player/VRHands.ts';
import { BootSettings } from './ui/BootSettings.ts';
import { installShipCollision } from './world/ShipCollisionSystem.ts';

const BUILD_TAG = 'BUILD-MODE-V24-RIFTMAW-HUNTER';

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

  const riverRocks = new RiverRockSystem(game.scene);
  game.content.register(riverRocks);
  settings.setStatus(`${BUILD_TAG} · loading PBR river rocks`);
  await riverRocks.ready;

  const seaGrass = new SeaGrassSystem(game.scene, {
    densityMultiplier: grassDensityPercent / 100,
    renderDistance: grassRenderDistance,
  });
  game.content.register(seaGrass);
  settings.setStatus(`${BUILD_TAG} · loading shallow vegetation`);
  await seaGrass.ready;

  const giantMushrooms = new GiantMushroomSystem(game.scene);
  game.content.register(giantMushrooms);
  settings.setStatus(`${BUILD_TAG} · loading giant alien mushrooms`);
  await giantMushrooms.ready;

  const colossusMushroom = new ColossusMushroomSystem(
    game.scene,
    game.density,
    game.biomes,
    game.environment,
  );
  settings.setStatus(`${BUILD_TAG} · loading colossus mushroom landmark`);
  await colossusMushroom.ready;

  const riftmawHunter = new RiftmawHunterSystem(
    game.scene,
    game.density,
    game.environment,
    game.rig,
    colossusMushroom,
  );
  settings.setStatus(`${BUILD_TAG} · loading Riftmaw hunter`);
  await riftmawHunter.ready;

  const prismFish = new PrismFishSystem(
    game.scene,
    game.density,
    game.biomes,
    game.environment,
    game.rig,
  );
  settings.setStatus(`${BUILD_TAG} · loading prism fish`);
  await prismFish.ready;

  const alienFish = new AlienFishSystem(
    game.scene,
    game.density,
    game.biomes,
    game.environment,
    game.rig,
  );
  settings.setStatus(`${BUILD_TAG} · loading alien fish`);
  await alienFish.ready;

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

  const fruitMushrooms = new FruitMushroomSystem(
    game.scene,
    game.renderer,
    hands,
    mode,
  );
  game.content.register(fruitMushrooms);
  settings.setStatus(`${BUILD_TAG} · loading harvestable fruit mushrooms`);
  await fruitMushrooms.ready;

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
  let speargun: SpeargunSystem | null = null;
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

    speargun = new SpeargunSystem(
      game.renderer,
      hands,
      game.scene,
      game.rig,
      game.density,
      prismFish,
      alienFish,
    );
    settings.setStatus(`${BUILD_TAG} · loading one-hand speargun`);
    await speargun.ready;
  }

  // Story reserves triggers for held tools. Build reserves them for the editor.
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
    alienFish.update(dt, elapsed);
    riftmawHunter.update(dt, elapsed);
    speargun?.update(dt);
    octopusCrabs.update(dt);
    plankton.update(dt, elapsed);
    colossusMushroom.update(elapsed);
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
    fruitMushrooms: FruitMushroomSystem;
    speargun: SpeargunSystem | null;
    riftmaw: RiftmawHunterSystem;
  }).game = game;
  (window as unknown as {
    game: Game;
    build: BuildSystem;
    headlamp: Headlamp | null;
    plankton: BioluminescentPlankton;
    fruitMushrooms: FruitMushroomSystem;
    speargun: SpeargunSystem | null;
    riftmaw: RiftmawHunterSystem;
  }).build = authoredWorld;
  (window as unknown as {
    game: Game;
    build: BuildSystem;
    headlamp: Headlamp | null;
    plankton: BioluminescentPlankton;
    fruitMushrooms: FruitMushroomSystem;
    speargun: SpeargunSystem | null;
    riftmaw: RiftmawHunterSystem;
  }).headlamp = headlamp;
  (window as unknown as {
    game: Game;
    build: BuildSystem;
    headlamp: Headlamp | null;
    plankton: BioluminescentPlankton;
    fruitMushrooms: FruitMushroomSystem;
    speargun: SpeargunSystem | null;
    riftmaw: RiftmawHunterSystem;
  }).plankton = plankton;
  (window as unknown as { snapBulbs: SnapBulbSystem }).snapBulbs = snapBulbs;
  (window as unknown as { fruitMushrooms: FruitMushroomSystem }).fruitMushrooms = fruitMushrooms;
  (window as unknown as { speargun: SpeargunSystem | null }).speargun = speargun;
  (window as unknown as { riftmaw: RiftmawHunterSystem }).riftmaw = riftmawHunter;

  await game.start((progress, label) => {
    bootFill.style.width = `${Math.round(progress * 100)}%`;
    settings.setStatus(`${BUILD_TAG} · ${mode.toUpperCase()} · ${label}`);
  });

  if (mode === 'build') {
    hint.textContent = 'BUILD · right-hand laser aims · right trigger selects · right grip grabs pointed prop · left trigger menu · A/X up · B/Y down';
  } else {
    hint.textContent = 'STORY · right grip picks up speargun · right trigger fires · grip hanging mushroom fruit to harvest · tap head to toggle lamp';
  }

  boot.classList.add('hidden');
  setTimeout(() => boot.remove(), 800);
  setTimeout(() => hint.classList.add('faded'), mode === 'build' ? 16000 : 9000);
}

bootstrap().catch((error: unknown) => {
  console.error(error);
  settings.setStatus(`${BUILD_TAG} · failed: ${error instanceof Error ? error.message : String(error)}`);
});
