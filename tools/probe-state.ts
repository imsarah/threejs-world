/** Probe live scene lighting state: sun light params, scene lights, shadow rig. */
import { launchWebGPU, laasUrl } from './launch';

async function main(): Promise<void> {
  const T = Number(process.argv[2] ?? 16.5);
  const { browser } = await launchWebGPU();
  const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
  page.on('console', (m) => console.log('[page]', m.text()));
  await page.goto(
    laasUrl({
      scene: 'terrain',
      T,
      extra: { x: '-380', z: '600', alt: '14', yaw: '0.8' },
    }),
    { waitUntil: 'domcontentloaded' },
  );
  await page.waitForFunction(
    () => window.__laas && (window.__laas.ready || window.__laas.error !== null),
    undefined,
    { timeout: 240000, polling: 250 },
  );
  const state = await page.evaluate(() => {
    const dbg = (window as unknown as { __laasDbg?: { engine?: unknown; sunSky?: unknown } })
      .__laasDbg;
    if (!dbg) return { error: 'no __laasDbg handle' };
    const engine = dbg.engine as {
      scene: { traverse: (cb: (o: unknown) => void) => void };
    };
    const sunSky = dbg.sunSky as { sun?: unknown; timeOfDay?: number };
    const lights: Record<string, unknown>[] = [];
    engine.scene.traverse((o: unknown) => {
      const l = o as {
        isLight?: boolean;
        type?: string;
        intensity?: number;
        visible?: boolean;
        castShadow?: boolean;
        position?: { x: number; y: number; z: number };
        color?: { r: number; g: number; b: number };
        parent?: unknown;
      };
      if (l.isLight) {
        lights.push({
          type: l.type,
          intensity: l.intensity,
          visible: l.visible,
          castShadow: l.castShadow,
          pos: l.position ? [l.position.x, l.position.y, l.position.z] : null,
          color: l.color ? [l.color.r, l.color.g, l.color.b] : null,
        });
      }
    });
    const sun = sunSky.sun as {
      intensity?: number;
      visible?: boolean;
      castShadow?: boolean;
      parent?: { type?: string } | null;
      position?: { x: number; y: number; z: number };
      target?: { parent?: unknown } | null;
    } | null;
    return {
      timeOfDay: sunSky.timeOfDay,
      sun: sun
        ? {
            intensity: sun.intensity,
            visible: sun.visible,
            castShadow: sun.castShadow,
            inScene: !!sun.parent,
            parentType: sun.parent?.type ?? null,
            pos: sun.position ? [sun.position.x, sun.position.y, sun.position.z] : null,
            targetInScene: !!sun.target?.parent,
          }
        : null,
      lights,
    };
  });
  console.log(JSON.stringify(state, null, 2));
  await browser.close();
}
void main();
