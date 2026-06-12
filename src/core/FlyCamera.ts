/**
 * Free-fly camera: pointer-lock mouse look, WASD/QE movement, shift boost,
 * scroll-wheel speed scaling. `P` logs the current pose as a `?cam=` string —
 * used to author bookmarks. Poses settable/gettable via hooks for tooling.
 */

import type { PerspectiveCamera } from 'three';
import { Vector3 } from 'three';
import type { CamPose } from './Hooks';

const FORWARD = new Vector3();
const RIGHT = new Vector3();
const MOVE = new Vector3();

export class FlyCamera {
  readonly camera: PerspectiveCamera;
  yaw = 0;
  pitch = 0;
  /** base speed in m/s, scroll-scaled */
  speed = 24;
  private keys = new Set<string>();
  private vel = new Vector3();
  private locked = false;
  enabled = true;

  constructor(camera: PerspectiveCamera, dom: HTMLElement) {
    this.camera = camera;

    dom.addEventListener('click', () => {
      if (this.enabled && !this.locked) void dom.requestPointerLock();
    });
    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === dom;
    });
    document.addEventListener('mousemove', (e) => {
      if (!this.locked) return;
      this.yaw -= e.movementX * 0.0022;
      this.pitch -= e.movementY * 0.0022;
      this.pitch = Math.max(-1.55, Math.min(1.55, this.pitch));
    });
    window.addEventListener('keydown', (e) => {
      if (e.code === 'KeyP') {
        // eslint-disable-next-line no-console
        console.log(`[pose] cam=${this.toCamString()}`);
      }
      this.keys.add(e.code);
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());
    dom.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        this.speed *= Math.pow(1.15, -Math.sign(e.deltaY));
        this.speed = Math.min(2000, Math.max(0.5, this.speed));
      },
      { passive: false },
    );
  }

  setPose(pose: CamPose): void {
    this.camera.position.set(pose.p[0], pose.p[1], pose.p[2]);
    this.yaw = pose.yaw;
    this.pitch = pose.pitch;
    if (pose.fov !== undefined) {
      this.camera.fov = pose.fov;
      this.camera.updateProjectionMatrix();
    }
    this.applyRotation();
    // recompose matrixWorld/matrixWorldInverse NOW: subsystems copy camera
    // state in their own updateFns and must never read a stale matrix
    this.camera.updateMatrixWorld();
  }

  getPose(): CamPose {
    return {
      p: [this.camera.position.x, this.camera.position.y, this.camera.position.z],
      yaw: this.yaw,
      pitch: this.pitch,
      fov: this.camera.fov,
    };
  }

  toCamString(): string {
    const p = this.camera.position;
    const f = (v: number): string => v.toFixed(2);
    return `${f(p.x)},${f(p.y)},${f(p.z)},${this.yaw.toFixed(4)},${this.pitch.toFixed(4)},${this.camera.fov.toFixed(0)}`;
  }

  private applyRotation(): void {
    this.camera.rotation.set(0, 0, 0);
    this.camera.rotateY(this.yaw);
    this.camera.rotateX(this.pitch);
  }

  update(dt: number): void {
    if (!this.enabled) return;
    this.applyRotation();

    FORWARD.set(0, 0, -1).applyQuaternion(this.camera.quaternion);
    RIGHT.set(1, 0, 0).applyQuaternion(this.camera.quaternion);
    MOVE.set(0, 0, 0);
    if (this.keys.has('KeyW')) MOVE.add(FORWARD);
    if (this.keys.has('KeyS')) MOVE.sub(FORWARD);
    if (this.keys.has('KeyD')) MOVE.add(RIGHT);
    if (this.keys.has('KeyA')) MOVE.sub(RIGHT);
    if (this.keys.has('KeyE')) MOVE.y += 1;
    if (this.keys.has('KeyQ')) MOVE.y -= 1;
    let target = 0;
    if (MOVE.lengthSq() > 0) {
      MOVE.normalize();
      target = this.speed;
      if (this.keys.has('ShiftLeft') || this.keys.has('ShiftRight')) target *= 6;
      if (this.keys.has('AltLeft')) target *= 0.15;
    }
    const damp = 1 - Math.exp(-dt * 9);
    this.vel.lerp(MOVE.multiplyScalar(target), damp);
    this.camera.position.addScaledVector(this.vel, dt);
    // matrices fresh for every subsystem updateFn that runs after this one
    this.camera.updateMatrixWorld();
  }
}
