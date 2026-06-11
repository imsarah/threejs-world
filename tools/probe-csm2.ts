/** Probe CSM breaks/extents; then re-run updateFrustums() live and re-probe. */
import { launchWebGPU, laasUrl } from './launch';

async function main(): Promise<void> {
  const { browser } = await launchWebGPU();
  const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
  await page.goto(
    laasUrl({
      scene: 'terrain',
      T: 16.5,
      extra: { x: '-380', z: '600', alt: '14', yaw: '0.8' },
    }),
    { waitUntil: 'domcontentloaded' },
  );
  await page.waitForFunction(
    () => window.__laas && (window.__laas.ready || window.__laas.error !== null),
    undefined,
    { timeout: 240000, polling: 250 },
  );
  const read = async (label: string): Promise<void> => {
    const s = await page.evaluate(() => {
      const dbg = (
        window as unknown as { __laasDbg?: { shadowRig?: { csm?: unknown } } }
      ).__laasDbg;
      const csm = dbg?.shadowRig?.csm as {
        breaks?: number[];
        camera?: { near?: number; far?: number; aspect?: number; fov?: number };
        mainFrustum?: { vertices?: { far?: { x: number; y: number; z: number }[] } };
        lights?: { shadow?: { camera?: { left: number; right: number }; bias?: number } }[];
      };
      return {
        breaks: csm?.breaks,
        cam: csm?.camera
          ? { near: csm.camera.near, far: csm.camera.far, aspect: csm.camera.aspect, fov: csm.camera.fov }
          : null,
        mainFar0: csm?.mainFrustum?.vertices?.far?.[0]
          ? [csm.mainFrustum.vertices.far[0].x, csm.mainFrustum.vertices.far[0].y, csm.mainFrustum.vertices.far[0].z]
          : null,
        extents: (csm?.lights ?? []).map((l) => [l.shadow?.camera?.left, l.shadow?.camera?.right]),
        biases: (csm?.lights ?? []).map((l) => l.shadow?.bias),
      };
    });
    console.log(label, JSON.stringify(s));
  };
  await read('BEFORE');
  await page.evaluate(() => {
    const dbg = (
      window as unknown as { __laasDbg?: { shadowRig?: { csm?: { updateFrustums?: () => void } } } }
    ).__laasDbg;
    dbg?.shadowRig?.csm?.updateFrustums?.();
  });
  await read('AFTER ');
  await page.evaluate(async () => window.__laas.settle && (await window.__laas.settle(30)));
  await page.screenshot({ path: 'shots/wip/csm-refrustum.png' });
  await browser.close();
}
void main();
