/**
 * Cloud-lag repro (user bug 2026-06-13): clouds shift with camera motion and
 * settle back over several frames.
 *
 * Design: frame-locked runs of the same boot (seed-deterministic), every
 * capture at the SAME absolute frame number so TRAA jitter index and the
 * frameU hash phase match exactly (unaligned captures differ 20-27% from
 * phase alone — STATUS methodology). ONE screenshot per boot — screenshots
 * advance the frame counter unpredictably (~15 frames of compositor work):
 *   run A (static): converge at bookmark 3, capture at frame N.
 *   run B (motion): identical, but ORBIT_FRAMES frames before N orbit the
 *     camera 0.01 rad/frame ENDING at the bookmark pose, optionally STOP
 *     frames early (--stop k → orbit ends at N-k = "stopped k frames ago").
 * The same-frame diff isolates motion-history artifacts at the instant
 * motion stops (+k frames of catch-up with --stop k).
 *
 *   npx tsx tools/probe-cloudlag.ts [--ablate taa] [--stop k] [--tag name]
 *     [--axis yaw|pitch] [--extra k=v,k=v]
 * --axis pitch swings pitch instead of yaw (sky-velocity y-sign check).
 *
 * Wind disabled + worldTime frozen; TSL wall-clock water still animates
 * (far + tiny at this framing).
 */

import { mkdirSync } from 'node:fs';
import sharp from 'sharp';
import type { Page } from 'playwright';
import { launchWebGPU, laasUrl } from './launch';

const FRAME_N = 420;
const ORBIT_FRAMES = 30;
// ~2.9°/frame — a realistic interactive pan (mouse look is 0.0022 rad/px).
// NOTE for pitch runs: large pitch swings change scene luminance enough to
// leave an auto-exposure transient in the capture (whole-frame diff) — use
// --step 0.012 there and compare configurations RELATIVELY.
const ORBIT_STEP = 0.05;

function arg(k: string, d: string): string {
  const i = process.argv.indexOf(`--${k}`);
  return i >= 0 ? (process.argv[i + 1] ?? d) : d;
}

async function diffPct(aPath: string, bPath: string, skyFrac: number): Promise<string> {
  const a = await sharp(aPath).raw().toBuffer({ resolveWithObject: true });
  const b = await sharp(bPath).raw().toBuffer({ resolveWithObject: true });
  const ch = a.info.channels;
  const w = a.info.width;
  const h = a.info.height;
  const skyRows = Math.floor(h * skyFrac);
  let full = 0;
  let sky = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      let m = 0;
      for (let c = 0; c < Math.min(ch, 3); c++) {
        const dv = Math.abs((a.data[i * ch + c] ?? 0) - (b.data[i * ch + c] ?? 0));
        if (dv > m) m = dv;
      }
      if (m > 12) {
        full++;
        if (y < skyRows) sky++;
      }
    }
  }
  const fullPct = ((full / (w * h)) * 100).toFixed(2);
  const skyPct = ((sky / (w * skyRows)) * 100).toFixed(2);
  return `sky-band ${skyPct}% · full ${fullPct}%`;
}

async function boot(ablate: string): Promise<Page> {
  const { browser } = await launchWebGPU();
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.on('pageerror', (err) => console.error('[pageerror]', err.message));
  const extra: Record<string, string> = { shot: '3', wind: '0' };
  for (const kv of arg('extra', '').split(',')) {
    const [k, v] = kv.split('=');
    if (k && v !== undefined) extra[k] = v;
  }
  if (ablate) extra.ablate = ablate;
  await page.goto(laasUrl({ scene: 'world', extra }), { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => window.__laas && (window.__laas.ready || window.__laas.error !== null),
    undefined,
    { timeout: 240000, polling: 250 },
  );
  const err = await page.evaluate(() => window.__laas.error);
  if (err) throw new Error(err);
  return page;
}

/** settle one frame at a time until stats.frame === target */
async function settleToFrame(page: Page, target: number): Promise<void> {
  await page.evaluate(async (t) => {
    const hk = window.__laas;
    if (!hk.settle || !hk.stats) throw new Error('hooks missing');
    for (let guard = 0; guard < 5000 && hk.stats.frame < t; guard++) await hk.settle(1);
    if (hk.stats.frame !== t) throw new Error(`overshot: at ${hk.stats.frame}, wanted ${t}`);
  }, target);
}

/**
 * --mode dbg: shader-level sign validation via ?skyveldbg=1 — captures a
 * MID-ORBIT frame of |analytic − geometry-velocity| over far mountains
 * (R = x-err ×20, G = y-err ×20, B = mask) and prints the masked means.
 * Runs with ablate=taa (no jitter → clean velocity). Near-zero = correct.
 */
async function dbgMode(axis: string, step: number, extraArg: string): Promise<void> {
  const { browser } = await launchWebGPU();
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.on('pageerror', (err) => console.error('[pageerror]', err.message));
  const extra: Record<string, string> = { shot: '3', wind: '0', skyveldbg: '1', ablate: 'taa' };
  for (const kv of extraArg.split(',')) {
    const [k, v] = kv.split('=');
    if (k && v !== undefined) extra[k] = v;
  }
  await page.goto(laasUrl({ scene: 'world', extra }), { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => window.__laas && (window.__laas.ready || window.__laas.error !== null),
    undefined,
    { timeout: 240000, polling: 250 },
  );
  const err = await page.evaluate(() => window.__laas.error);
  if (err) throw new Error(err);
  await page.evaluate(async () => window.__laas.settle && (await window.__laas.settle(24)));
  await page.evaluate(
    async (o) => {
      const hk = window.__laas;
      if (!hk.getPose || !hk.setPose || !hk.settle) throw new Error('pose hooks missing');
      const p0 = hk.getPose();
      for (let k = 0; k < 8; k++) {
        const off = (8 - 1 - k) * o.step;
        hk.setPose({
          p: p0.p,
          yaw: o.axis === 'pitch' ? p0.yaw : p0.yaw - off,
          pitch: o.axis === 'pitch' ? p0.pitch + off : p0.pitch,
        });
        await hk.settle(1);
      }
    },
    { step, axis },
  );
  const shot = `shots/wip/cloudlag/dbg-${axis}${arg('extra', '') ? '-b' : ''}.png`;
  await page.screenshot({ path: shot });
  await page.context().browser()?.close();

  const img = await sharp(shot).raw().toBuffer({ resolveWithObject: true });
  const ch = img.info.channels;
  let n = 0;
  let sumR = 0;
  let sumG = 0;
  for (let i = 0; i < img.info.width * img.info.height; i++) {
    if ((img.data[i * ch + 2] ?? 0) > 128) {
      n++;
      sumR += img.data[i * ch] ?? 0;
      sumG += img.data[i * ch + 1] ?? 0;
    }
  }
  console.log(
    `[skyvel-dbg:${axis}${arg('extra', '')}] far-geometry px ${n}: mean x-err ${(sumR / n).toFixed(1)}/255 · mean y-err ${(sumG / n).toFixed(1)}/255 (×20 scale)`,
  );
}

async function main(): Promise<void> {
  const ablate = arg('ablate', '');
  const stop = Number(arg('stop', '0'));
  const axis = arg('axis', 'yaw');
  const step = Number(arg('step', String(ORBIT_STEP)));
  if (arg('mode', '') === 'dbg') {
    await dbgMode(axis, step, arg('extra', ''));
    return;
  }
  const tag = arg(
    'tag',
    (ablate ? `ablate-${ablate}` : 'default') +
      (stop ? `-stop${stop}` : '') +
      (axis !== 'yaw' ? `-${axis}` : ''),
  );
  const dir = 'shots/wip/cloudlag';
  mkdirSync(dir, { recursive: true });

  // run A — static throughout, capture at frame N
  let page = await boot(ablate);
  await settleToFrame(page, FRAME_N);
  const aShot = `${dir}/${tag}-static.png`;
  await page.screenshot({ path: aShot });
  await page.context().browser()?.close();

  // run B — orbit's LAST step lands the bookmark pose for frame N-stop (the
  // first frame rendered back at the pose); extra `stop` frames of catch-up;
  // capture at frame N exactly like run A
  page = await boot(ablate);
  await settleToFrame(page, FRAME_N - stop - ORBIT_FRAMES);
  await page.evaluate(
    async (o) => {
      const hk = window.__laas;
      if (!hk.getPose || !hk.setPose || !hk.settle) throw new Error('pose hooks missing');
      const p0 = hk.getPose();
      for (let k = 0; k < o.n; k++) {
        const off = (o.n - 1 - k) * o.step;
        hk.setPose({
          p: p0.p,
          yaw: o.axis === 'pitch' ? p0.yaw : p0.yaw - off,
          // pitch swings DOWN from above the bookmark pose (sky-rich history)
          pitch: o.axis === 'pitch' ? p0.pitch + off : p0.pitch,
        });
        await hk.settle(1);
      }
    },
    { n: ORBIT_FRAMES, step, axis },
  );
  if (stop > 0) await settleToFrame(page, FRAME_N);
  const bShot = `${dir}/${tag}-motion.png`;
  await page.screenshot({ path: bShot });
  await page.context().browser()?.close();

  console.log(
    `[cloudlag:${tag}] stop+${stop} (frame ${FRAME_N}): ${await diffPct(aShot, bShot, 0.45)}`,
  );
}

void main().catch((e: unknown) => {
  console.error('[probe-cloudlag] FAILED:', e instanceof Error ? e.message : e);
  process.exit(1);
});
