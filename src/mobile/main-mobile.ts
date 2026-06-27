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
  const clock = new Clock();

  const loop = (): void => {
    const dt = Math.min(clock.getDelta(), 0.05);
    controls.update(dt);
    world.update(clock.elapsedTime * 1.5);
    renderer.render(world.scene, camera);
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);

  addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });
}

const probe = document.createElement('canvas').getContext('webgl2');
if (!probe) {
  fail('This scene needs WebGL2. Please use an up-to-date mobile browser.');
} else {
  start();
}
