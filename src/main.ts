import { Game } from './core/Game.ts';

/**
 * Bootstrap.
 *
 * URL parameters (all optional):
 *   ?seed=12345    world seed
 *   ?debug=1       start with the debug HUD visible
 *   ?view=4        view distance in chunks
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
const bootStatus = document.getElementById('boot-status')!;
const hint = document.getElementById('hint')!;
const hudElement = document.getElementById('debug-hud')!;

const game = new Game(document.body, hudElement, {
  debug: params.get('debug') === '1',
  world: {
    ...(number('seed') !== undefined ? { seed: number('seed')! } : {}),
    ...(number('view') !== undefined ? { viewDistanceChunks: number('view')! } : {}),
    ...(number('workers') !== undefined ? { workerCount: number('workers')! } : {}),
  },
});

game
  .start((progress, label) => {
    bootFill.style.width = `${Math.round(progress * 100)}%`;
    bootStatus.textContent = label;
  })
  .then(() => {
    boot.classList.add('hidden');
    setTimeout(() => boot.remove(), 800);
    setTimeout(() => hint.classList.add('faded'), 9000);
  })
  .catch((error: unknown) => {
    console.error(error);
    bootStatus.textContent = `failed: ${error instanceof Error ? error.message : String(error)}`;
  });

// Handy for poking at the world from the browser console.
(window as unknown as { game: Game }).game = game;
