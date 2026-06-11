/** Probe live CSMShadowNode internals: which camera it captured, cascade
 *  light positions, frustum/map state. */
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
  await page.evaluate(async () => window.__laas.settle && (await window.__laas.settle(10)));
  const state = await page.evaluate(() => {
    const dbg = (
      window as unknown as {
        __laasDbg?: { shadowRig?: { csm?: unknown }; engine?: { camera?: unknown } };
      }
    ).__laasDbg;
    const csm = dbg?.shadowRig?.csm as {
      camera?: { type?: string; position?: { toArray(): number[] }; isPerspectiveCamera?: boolean } | null;
      cascades?: number;
      maxFar?: number;
      fade?: boolean;
      lights?: {
        position: { toArray(): number[] };
        intensity?: number;
        castShadow?: boolean;
        parent: unknown;
        shadow?: {
          camera?: { left: number; right: number; top: number; bottom: number; near: number; far: number };
          mapSize?: { x: number; y: number };
          map?: unknown;
        };
      }[];
      frustums?: unknown[];
    } | null;
    const engCam = dbg?.engine?.camera as { position?: { toArray(): number[] }; type?: string } | undefined;
    if (!csm) return { error: 'no csm on rig' };
    return {
      engineCamera: { type: engCam?.type, pos: engCam?.position?.toArray() },
      csmCamera: csm.camera
        ? { type: csm.camera.type, pos: csm.camera.position?.toArray() }
        : null,
      sameObject: csm.camera === engCam,
      cascades: csm.cascades,
      maxFar: csm.maxFar,
      fade: csm.fade,
      frustums: csm.frustums?.length,
      lights: (csm.lights ?? []).map((l) => ({
        pos: l.position.toArray().map((v: number) => Math.round(v)),
        castShadow: l.castShadow,
        inScene: !!l.parent,
        cam: l.shadow?.camera
          ? {
              l: Math.round(l.shadow.camera.left),
              r: Math.round(l.shadow.camera.right),
              t: Math.round(l.shadow.camera.top),
              b: Math.round(l.shadow.camera.bottom),
              n: Math.round(l.shadow.camera.near),
              f: Math.round(l.shadow.camera.far),
            }
          : null,
        mapSize: l.shadow?.mapSize ? [l.shadow.mapSize.x, l.shadow.mapSize.y] : null,
        hasMap: !!l.shadow?.map,
      })),
    };
  });
  console.log(JSON.stringify(state, null, 2));
  await browser.close();
}
void main();
