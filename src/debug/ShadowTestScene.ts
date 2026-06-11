/**
 * ?scene=shadowtest — minimal shadow repro: ground plane + boxes + one
 * DirectionalLight. NO post stack, NO atmosphere, NO GI by default. Switches:
 *   ?csm=1 (default) routes through setupSunShadows (CSMShadowNode + PCSS)
 *   ?csm=0 plain DirectionalLight shadow (three defaults)
 *   ?sunsky=1 use the SunSky rig's DirectionalLight instead of a local one
 *   ?post=1 wrap rendering in the PostStack (requires sunsky=1)
 * Binary-searches which layer of the real pipeline eats the shadows.
 */

import {
  AmbientLight,
  BoxGeometry,
  DirectionalLight,
  Mesh,
  MeshStandardMaterial,
  PlaneGeometry,
} from 'three';
import { setupSunShadows } from '../render/ShadowSetup';
import { PostStack } from '../render/PostStack';
import { SunSky } from '../sky/SunSky';
import type { WorldContext } from './Scenes';

export async function buildShadowTestScene(ctx: WorldContext): Promise<void> {
  const { engine, params } = ctx;
  const q = new URLSearchParams(window.location.search);
  const useCsm = q.get('csm') !== '0';
  const useSunSky = q.get('sunsky') === '1';
  const usePost = q.get('post') === '1';

  const ground = new Mesh(
    new PlaneGeometry(400, 400),
    new MeshStandardMaterial({ color: 0x88aa66 }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  engine.scene.add(ground);

  for (let i = 0; i < 8; i++) {
    const h = 2 + (i % 4) * 2;
    const box = new Mesh(
      new BoxGeometry(2, h, 2),
      new MeshStandardMaterial({ color: 0xaa7755 }),
    );
    box.position.set(-30 + i * 9, h / 2, -10 + (i % 3) * 12);
    box.castShadow = true;
    box.receiveShadow = true;
    engine.scene.add(box);
  }

  let sun: DirectionalLight;
  let sunSky: SunSky | null = null;
  if (useSunSky) {
    sunSky = new SunSky(engine, params.timeOfDay);
    await sunSky.init(engine.renderer);
    sun = sunSky.sun;
  } else {
    sun = new DirectionalLight(0xffffff, 3);
    sun.position.set(120, 180, 80);
    engine.scene.add(sun);
    engine.scene.add(sun.target);
    engine.scene.add(new AmbientLight(0x668899, 0.5));
  }

  if (useCsm) {
    setupSunShadows(sun, engine.camera);
  } else {
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.camera.near = 1;
    sun.shadow.camera.far = 600;
    sun.shadow.camera.left = -120;
    sun.shadow.camera.right = 120;
    sun.shadow.camera.top = 120;
    sun.shadow.camera.bottom = -120;
  }

  if (usePost && sunSky) {
    engine.post = new PostStack(engine, sunSky.atmosphere, params.timeOfDay, null);
  }

  engine.camera.position.set(30, 25, 55);
  engine.camera.lookAt(0, 0, 0);
  ctx.progress(1, 'shadowtest ready');
}
