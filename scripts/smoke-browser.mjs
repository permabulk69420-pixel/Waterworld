/**
 * Headless browser smoke test.
 *
 * Loads the production build in Chromium (software GL), waits for the world to
 * finish generating, then drives the desktop controls for a few seconds and
 * reports console errors, WebGL warnings and the runtime stats the debug HUD
 * would show. Run with `npm run smoke` after `npm run build`.
 */
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

const ROOT = new URL('../dist/', import.meta.url).pathname;
const PORT = 4319;

const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.map': 'application/json',
  '.json': 'application/json',
};

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    let path = normalize(join(ROOT, decodeURIComponent(url.pathname)));
    if (!path.startsWith(ROOT)) throw new Error('escape');
    const info = await stat(path).catch(() => null);
    if (!info || info.isDirectory()) path = join(ROOT, 'index.html');
    const body = await readFile(path);
    res.writeHead(200, { 'content-type': MIME[extname(path)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
});

await new Promise((resolve) => server.listen(PORT, resolve));

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: [
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--no-sandbox',
  ],
});

const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
const warnings = [];

page.on('console', (msg) => {
  const text = msg.text();
  if (msg.type() === 'error') errors.push(text);
  else if (msg.type() === 'warning') warnings.push(text);
});
page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));

console.log('loading...');
await page.goto(`http://localhost:${PORT}/?debug=1`, { waitUntil: 'load' });

// Wait for terrain generation to finish.
await page.waitForFunction(
  () => document.getElementById('boot')?.classList.contains('hidden') ?? true,
  null,
  { timeout: 90_000 },
);
console.log('world ready');

const readStats = () =>
  page.evaluate(() => {
    const g = window.game;
    const head = new g.rig.camera.position.constructor();
    g.rig.getHeadPosition(head);
    return {
      chunks: g.chunks.stats,
      depth: g.environment.depth,
      submergence: g.environment.submergence,
      underwater: g.environment.underwater,
      head: { x: head.x, y: head.y, z: head.z },
      speed: g.locomotion.state.speed,
      contacts: g.locomotion.state.contacts,
      colliders: g.collision.colliderCount,
      collisionTris: g.collision.triangleCount,
      drawCalls: g.renderer.info.render.calls,
      triangles: g.renderer.info.render.triangles,
      fogDensity: g.scene.fog.density,
      fogColor: g.scene.fog.color.getHexString(),
      seabed: g.density.seabedAt(head.x, head.z),
    };
  });

const initial = await readStats();
console.log('\ninitial state');
console.log(JSON.stringify(initial, null, 2));

// --- drive the desktop controls ------------------------------------------
// Software GL runs at a few fps, and the frame loop clamps dt, so wall-clock
// key holds advance very little simulated time. Hold until the world reaches
// the state we care about instead, with a generous wall-clock ceiling.
async function holdUntil(key, label, predicate, timeoutMs = 60_000) {
  await page.keyboard.down(key);
  const start = Date.now();
  let stats = await readStats();
  while (!predicate(stats) && Date.now() - start < timeoutMs) {
    await page.waitForTimeout(400);
    stats = await readStats();
  }
  await page.keyboard.up(key);
  const ok = predicate(stats);
  console.log(`  ${label}: ${ok ? 'reached' : 'timed out'} after ${((Date.now() - start) / 1000).toFixed(1)}s`);
  return stats;
}

console.log('\ndriving controls');
const afterForward = await holdUntil(
  'KeyW',
  'swim forward 6m',
  (s) => Math.hypot(s.head.x - initial.head.x, s.head.z - initial.head.z) > 6,
);

const afterDescent = await holdUntil(
  'ControlLeft',
  'descend onto the seabed',
  (s) => s.contacts > 0 || s.head.y < s.seabed + 1.6,
);

const afterAscent = await holdUntil('Space', 'surface', (s) => !s.underwater);

console.log('  turning');
await page.keyboard.down('KeyE');
await page.waitForTimeout(1500);
await page.keyboard.up('KeyE');

// Sample framerate over a second of steady rendering.
const perf = await page.evaluate(
  () =>
    new Promise((resolve) => {
      let frames = 0;
      const start = performance.now();
      const tick = () => {
        frames++;
        if (performance.now() - start < 1500) requestAnimationFrame(tick);
        else resolve({ fps: (frames * 1000) / (performance.now() - start) });
      };
      requestAnimationFrame(tick);
    }),
);

console.log('\nafter forward swim:', JSON.stringify(afterForward.head));
console.log('after descent:     ', JSON.stringify(afterDescent.head), `depth ${afterDescent.depth.toFixed(1)}m`);
console.log(
  'after ascent:      ',
  JSON.stringify(afterAscent.head),
  `depth ${afterAscent.depth.toFixed(1)}m underwater=${afterAscent.underwater}`,
);
console.log('software-GL fps:   ', perf.fps.toFixed(1));
console.log('draw calls:        ', afterAscent.drawCalls, ' triangles:', afterAscent.triangles);

let failures = 0;
const check = (name, ok, detail = '') => {
  if (ok) console.log(`  ok   ${name}${detail ? ` (${detail})` : ''}`);
  else {
    failures++;
    console.error(`  FAIL ${name}${detail ? ` (${detail})` : ''}`);
  }
};

console.log('\nchecks');
check('no console errors', errors.length === 0, errors.slice(0, 3).join(' | '));
check('chunks loaded', initial.chunks.loaded >= 20, `${initial.chunks.loaded}`);
check('terrain generated in workers', initial.chunks.usingWorkers);
check('colliders registered', initial.colliders >= 20, `${initial.colliders}`);
check(
  'player starts underwater above the seabed',
  initial.underwater && initial.head.y > initial.seabed,
  `y=${initial.head.y.toFixed(1)} seabed=${initial.seabed.toFixed(1)}`,
);
check(
  'forward input moves the player',
  Math.hypot(afterForward.head.x - initial.head.x, afterForward.head.z - initial.head.z) > 6,
);
check('descending increases depth', afterDescent.depth > initial.depth + 1);
check(
  'the seabed stops the player',
  afterDescent.contacts > 0,
  `${afterDescent.contacts} contacts at y=${afterDescent.head.y.toFixed(1)}, seabed ${afterDescent.seabed.toFixed(1)}`,
);
check(
  'player does not clip through the seabed',
  afterDescent.head.y > afterDescent.seabed - 0.5,
  `y=${afterDescent.head.y.toFixed(1)} seabed=${afterDescent.seabed.toFixed(1)}`,
);
check(
  'player can surface',
  !afterAscent.underwater,
  `depth ${afterAscent.depth.toFixed(2)} submergence ${afterAscent.submergence.toFixed(2)}`,
);
check(
  'fog switches between air and water',
  afterAscent.fogDensity < initial.fogDensity,
  `air ${afterAscent.fogDensity.toFixed(4)} vs water ${initial.fogDensity.toFixed(4)}`,
);
check('draw calls stay low', afterAscent.drawCalls < 80, `${afterAscent.drawCalls}`);

if (warnings.length) {
  console.log(`\n${warnings.length} console warning(s):`);
  for (const w of warnings.slice(0, 5)) console.log(`  - ${w}`);
}
if (errors.length) {
  console.log('\nerrors:');
  for (const e of errors.slice(0, 10)) console.log(`  - ${e}`);
}

await browser.close();
server.close();
console.log(failures === 0 ? '\nsmoke test passed\n' : `\n${failures} smoke check(s) failed\n`);
process.exit(failures === 0 ? 0 : 1);
