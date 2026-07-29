import { Game } from './core/Game.ts';
import { DEFAULT_WORLD_CONFIG } from './config/worldConfig.ts';
import { SeaGrassSystem } from './content/SeaGrassSystem.ts';
import { HandThrusters } from './player/HandThrusters.ts';
import { VRHands } from './player/VRHands.ts';
import { BootSettings } from './ui/BootSettings.ts';

const BUILD_TAG = 'MOTOR-XR-V6';

/**
 * Bootstrap.
 *
 * URL parameters (all optional):
 *   ?seed=12345         world seed
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
);
settings.setStatus(`${BUILD_TAG} · choose performance settings`);

async function bootstrap(): Promise<void> {
  const {
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

  const hands = new VRHands(game.renderer, game.rig.group);
  settings.setStatus(`${BUILD_TAG} · loading VR hands`);
  await hands.ready;

  const thrusters = new HandThrusters(
    game.renderer,
    hands,
    game.locomotion,
    game.scene,
    game.rig,
  );
  settings.setStatus(`${BUILD_TAG} · loading hand motors`);
  await thrusters.ready;

  game.xrInput.setTriggerVerticalEnabled(false);

  // Hands, pickups, propeller animation and propulsion all use the game's one
  // authoritative XR frame and the same dt.
  game.addFrameListener((dt) => {
    hands.update(dt);
    thrusters.update(dt);
  });

  (window as unknown as { game: Game }).game = game;

  await game.start((progress, label) => {
    bootFill.style.width = `${Math.round(progress * 100)}%`;
    settings.setStatus(`${BUILD_TAG} · ${label}`);
  });

  boot.classList.add('hidden');
  setTimeout(() => boot.remove(), 800);
  setTimeout(() => hint.classList.add('faded'), 9000);
}

bootstrap().catch((error: unknown) => {
  console.error(error);
  settings.setStatus(`${BUILD_TAG} · failed: ${error instanceof Error ? error.message : String(error)}`);
});
