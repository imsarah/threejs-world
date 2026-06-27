/**
 * Mobile entry — a lightweight WebGL2 scene (NOT the WebGPU engine). Runs on
 * phones: plain three.js renderer, first-person walk controls. Separate from
 * src/main.ts so none of the WebGPU/compute stack is pulled in.
 */

import {
  ACESFilmicToneMapping,
  Clock,
  PCFSoftShadowMap,
  PerspectiveCamera,
  SRGBColorSpace,
  WebGLRenderer,
} from 'three';
import { buildMobileWorld } from './MobileScene';
import { WalkControls } from './WalkControls';

function fail(msg: string): void {
  const app = document.getElementById('app');
  if (app) {
    app.innerHTML = `<div style="position:fixed;inset:0;display:flex;align-items:center;justify-content:center;color:#cdd;font-family:ui-monospace,monospace;font-size:14px;text-align:center;padding:24px">${msg}</div>`;
  }
}

function start(): void {
  const app = document.getElementById('app');
  if (!app) throw new Error('missing #app');

  const renderer = new WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = PCFSoftShadowMap;
  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.15;
  renderer.outputColorSpace = SRGBColorSpace;
  // claim touch gestures on the canvas itself — in-app browsers hijack
  // vertical drags (scroll / pull-to-dismiss) unless the element opts out
  renderer.domElement.style.touchAction = 'none';
  app.appendChild(renderer.domElement);

  const camera = new PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.1, 600);
  camera.rotation.order = 'YXZ';

  const world = buildMobileWorld(renderer);
  camera.position.set(0, world.heightAt(0, 0) + 1.6, 0);

  const controls = new WalkControls(camera, renderer.domElement, world.heightAt, world.bound);

  // forced-landscape toggle: in-app browsers often lock to portrait, so a
  // button rotates the canvas 90° (and WalkControls remaps touch input)
  let forced = false;
  const applyLayout = (): void => {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const el = renderer.domElement;
    if (forced) {
      renderer.setSize(h, w); // swapped buffer; CSS-rotated to fill the viewport
      camera.aspect = h / w;
      el.style.position = 'fixed';
      el.style.left = '50%';
      el.style.top = '50%';
      el.style.transformOrigin = 'center center';
      el.style.transform = 'translate(-50%, -50%) rotate(90deg)';
    } else {
      renderer.setSize(w, h);
      camera.aspect = w / h;
      el.style.position = '';
      el.style.left = '';
      el.style.top = '';
      el.style.transform = '';
      el.style.transformOrigin = '';
    }
    camera.updateProjectionMatrix();
  };
  applyLayout();

  document.getElementById('rotate-btn')?.addEventListener('click', () => {
    forced = !forced;
    document.body.classList.toggle('force-landscape', forced);
    controls.setRotation(forced);
    applyLayout();
  });

  const clock = new Clock();

  const loop = (): void => {
    const dt = Math.min(clock.getDelta(), 0.05);
    controls.update(dt);
    world.update(clock.elapsedTime * 1.5);
    renderer.render(world.scene, camera);
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);

  addEventListener('resize', applyLayout);
  addEventListener('orientationchange', applyLayout);
}

const probe = document.createElement('canvas').getContext('webgl2');
if (!probe) {
  fail('This scene needs WebGL2. Please use an up-to-date mobile browser.');
} else {
  start();
}
