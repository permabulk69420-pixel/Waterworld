import { Game } from './core/Game.ts';
import { DEFAULT_WORLD_CONFIG } from './config/worldConfig.ts';
import { SeaGrassSystem } from './content/SeaGrassSystem.ts';
import { VRHands } from './player/VRHands.ts';
import { BootSettings } from './ui/BootSettings.ts';

/**
 * Bootstrap.
 *
 * URL parameters (all optional):
 *   ?seed=12345    world seed
 *   ?debug=1       start with the debug HUD visible
 *   ?view=4        initial load-distance slider value
 *   ?workers=0     force main-thread terrain generation
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
const settings = new BootSettings(number('view'));

async function bootstrap(): Promise<void> {
  const { viewDistanceChunks } = await settings.waitForStart();

  // The original foundation temporarily bounded the authored region to +/-3
  // chunks. Grow that temporary boundary when the user asks to see farther so
  // the load-distance control actually has terrain available to stream.
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

  // First biome dressing pass. Register before terrain preload so every chunk is
  // populated the first time it streams in rather than requiring a reload cycle.
  const seaGrass = new SeaGrassSystem();
  game.content.register(seaGrass);
  settings.setStatus('loading shallow vegetation');
  await seaGrass.ready;

  // Reuse the apartment project's rigged hands. VRHands creates the tracked
  // controller/grip nodes under Waterworld's existing player rig, so the world
  // locomotion code remains untouched.
  const hands = new VRHands(game.renderer, game.rig.group);
  let xrLastFrameMs = 0;

  const updateXrSystems = (timeMs: number): void => {
    const session = game.renderer.xr.getSession();
    if (!session) {
      xrLastFrameMs = 0;
      return;
    }

    const dt = xrLastFrameMs === 0 ? 0 : Math.min((timeMs - xrLastFrameMs) / 1000, 0.05);
    xrLastFrameMs = timeMs;
    hands.update(dt);
    seaGrass.update(dt);
    session.requestAnimationFrame(updateXrSystems);
  };

  game.renderer.xr.addEventListener('sessionstart', () => {
    xrLastFrameMs = 0;
    game.renderer.xr.getSession()?.requestAnimationFrame(updateXrSystems);
  });
  game.renderer.xr.addEventListener('sessionend', () => {
    xrLastFrameMs = 0;
  });

  // Keep the same grass animation visible in the normal browser preview. While
  // WebXR is presenting the XR frame loop above owns vegetation updates instead.
  let desktopVegetationLastMs = 0;
  const updateDesktopVegetation = (timeMs: number): void => {
    if (!game.renderer.xr.isPresenting) {
      const dt = desktopVegetationLastMs === 0
        ? 0
        : Math.min((timeMs - desktopVegetationLastMs) / 1000, 0.05);
      desktopVegetationLastMs = timeMs;
      seaGrass.update(dt);
    } else {
      desktopVegetationLastMs = 0;
    }
    requestAnimationFrame(updateDesktopVegetation);
  };

  // Handy for poking at the world from the browser console.
  (window as unknown as { game: Game }).game = game;

  await game.start((progress, label) => {
    bootFill.style.width = `${Math.round(progress * 100)}%`;
    settings.setStatus(label);
  });
  requestAnimationFrame(updateDesktopVegetation);

  boot.classList.add('hidden');
  setTimeout(() => boot.remove(), 800);
  setTimeout(() => hint.classList.add('faded'), 9000);
}

bootstrap().catch((error: unknown) => {
  console.error(error);
  settings.setStatus(`failed: ${error instanceof Error ? error.message : String(error)}`);
});
