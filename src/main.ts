import { Game } from './core/Game.ts';
import { DEFAULT_WORLD_CONFIG } from './config/worldConfig.ts';
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

  // Handy for poking at the world from the browser console.
  (window as unknown as { game: Game }).game = game;

  await game.start((progress, label) => {
    bootFill.style.width = `${Math.round(progress * 100)}%`;
    settings.setStatus(label);
  });

  boot.classList.add('hidden');
  setTimeout(() => boot.remove(), 800);
  setTimeout(() => hint.classList.add('faded'), 9000);
}

bootstrap().catch((error: unknown) => {
  console.error(error);
  settings.setStatus(`failed: ${error instanceof Error ? error.message : String(error)}`);
});
