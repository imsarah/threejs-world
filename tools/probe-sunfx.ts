/** A/B the DirectionalLight contribution: intensity 0 vs ×6 screenshots. */
import { launchWebGPU, laasUrl } from './launch';

async function main(): Promise<void> {
  const { browser } = await launchWebGPU();
  const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
  await page.goto(
    laasUrl({
      scene: 'terrain',
      T: 16.5,
      extra: { x: '-380', z: '600', alt: '14', yaw: '0.8', pitch: '-0.12' },
    }),
    { waitUntil: 'domcontentloaded' },
  );
  await page.waitForFunction(
    () => window.__laas && (window.__laas.ready || window.__laas.error !== null),
    undefined,
    { timeout: 240000, polling: 250 },
  );
  const setSun = async (k: number): Promise<void> => {
    await page.evaluate((kk) => {
      const dbg = (window as unknown as { __laasDbg?: { sunSky?: { sun?: { intensity: number; userData: Record<string, number> } } } }).__laasDbg;
      const sun = dbg?.sunSky?.sun;
      if (!sun) return;
      if (sun.userData.baseI === undefined) sun.userData.baseI = sun.intensity;
      sun.intensity = (sun.userData.baseI as number) * kk;
    }, k);
    await page.evaluate(async () => window.__laas.settle && (await window.__laas.settle(50)));
  };
  await setSun(0);
  await page.screenshot({ path: 'shots/wip/sun-x0.png' });
  await setSun(6);
  await page.screenshot({ path: 'shots/wip/sun-x6.png' });
  await browser.close();
  console.log('wrote sun-x0 / sun-x6');
}
void main();
