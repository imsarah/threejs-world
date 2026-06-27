/**
 * First-person walk controls for touch + desktop.
 *  - Touch: LEFT half of the screen is a virtual joystick (move); RIGHT half is
 *    drag-to-look.
 *  - Desktop (for testing): WASD / arrows move, mouse-drag looks.
 * The camera is clamped to the terrain surface (eye height) and to the world
 * bounds every frame.
 */

import { Euler, Vector3 } from 'three';
import type { PerspectiveCamera } from 'three';

const MAX_PITCH = 1.4835; // ~85°
const LOOK_SENS = 0.0026;
const JOY_RADIUS = 64; // px to reach full speed

export class WalkControls {
  private readonly euler = new Euler(0, 0, 0, 'YXZ');
  private readonly keys = new Set<string>();
  private readonly fwd = new Vector3();
  private readonly right = new Vector3();

  private moveId: number | null = null;
  private lookId: number | null = null;
  private readonly joyStart = { x: 0, y: 0 };
  private readonly joy = { x: 0, y: 0 }; // -1..1 (x = strafe, y = forward)
  private readonly lookLast = { x: 0, y: 0 };
  private mouseDown = false;

  private readonly eyeHeight = 1.6;
  private readonly speed = 4.2;

  constructor(
    private readonly camera: PerspectiveCamera,
    private readonly dom: HTMLElement,
    private readonly heightAt: (x: number, z: number) => number,
    private readonly bound: number,
  ) {
    this.euler.setFromQuaternion(camera.quaternion);
    addEventListener('keydown', this.onKeyDown);
    addEventListener('keyup', this.onKeyUp);
    this.dom.addEventListener('mousedown', this.onMouseDown);
    addEventListener('mousemove', this.onMouseMove);
    addEventListener('mouseup', this.onMouseUp);
    this.dom.addEventListener('touchstart', this.onTouchStart, { passive: false });
    this.dom.addEventListener('touchmove', this.onTouchMove, { passive: false });
    this.dom.addEventListener('touchend', this.onTouchEnd);
    this.dom.addEventListener('touchcancel', this.onTouchEnd);
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    this.keys.add(e.key.toLowerCase());
  };
  private onKeyUp = (e: KeyboardEvent): void => {
    this.keys.delete(e.key.toLowerCase());
  };

  private onMouseDown = (e: MouseEvent): void => {
    this.mouseDown = true;
    this.lookLast.x = e.clientX;
    this.lookLast.y = e.clientY;
  };
  private onMouseMove = (e: MouseEvent): void => {
    if (!this.mouseDown) return;
    this.applyLook(e.clientX - this.lookLast.x, e.clientY - this.lookLast.y);
    this.lookLast.x = e.clientX;
    this.lookLast.y = e.clientY;
  };
  private onMouseUp = (): void => {
    this.mouseDown = false;
  };

  private onTouchStart = (e: TouchEvent): void => {
    e.preventDefault();
    const halfW = window.innerWidth / 2;
    for (const t of Array.from(e.changedTouches)) {
      if (t.clientX < halfW && this.moveId === null) {
        this.moveId = t.identifier;
        this.joyStart.x = t.clientX;
        this.joyStart.y = t.clientY;
        this.joy.x = 0;
        this.joy.y = 0;
      } else if (this.lookId === null) {
        this.lookId = t.identifier;
        this.lookLast.x = t.clientX;
        this.lookLast.y = t.clientY;
      }
    }
  };

  private onTouchMove = (e: TouchEvent): void => {
    e.preventDefault();
    for (const t of Array.from(e.changedTouches)) {
      if (t.identifier === this.moveId) {
        const dx = t.clientX - this.joyStart.x;
        const dy = t.clientY - this.joyStart.y;
        this.joy.x = Math.max(-1, Math.min(1, dx / JOY_RADIUS));
        this.joy.y = Math.max(-1, Math.min(1, -dy / JOY_RADIUS));
      } else if (t.identifier === this.lookId) {
        this.applyLook(t.clientX - this.lookLast.x, t.clientY - this.lookLast.y);
        this.lookLast.x = t.clientX;
        this.lookLast.y = t.clientY;
      }
    }
  };

  private onTouchEnd = (e: TouchEvent): void => {
    for (const t of Array.from(e.changedTouches)) {
      if (t.identifier === this.moveId) {
        this.moveId = null;
        this.joy.x = 0;
        this.joy.y = 0;
      } else if (t.identifier === this.lookId) {
        this.lookId = null;
      }
    }
  };

  private applyLook(dx: number, dy: number): void {
    this.euler.y -= dx * LOOK_SENS;
    this.euler.x -= dy * LOOK_SENS;
    this.euler.x = Math.max(-MAX_PITCH, Math.min(MAX_PITCH, this.euler.x));
  }

  update(dt: number): void {
    let mx = this.joy.x;
    let mz = this.joy.y;
    if (this.keys.has('w') || this.keys.has('arrowup')) mz += 1;
    if (this.keys.has('s') || this.keys.has('arrowdown')) mz -= 1;
    if (this.keys.has('a') || this.keys.has('arrowleft')) mx -= 1;
    if (this.keys.has('d') || this.keys.has('arrowright')) mx += 1;
    const len = Math.hypot(mx, mz);
    if (len > 1) {
      mx /= len;
      mz /= len;
    }

    const yaw = this.euler.y;
    this.fwd.set(-Math.sin(yaw), 0, -Math.cos(yaw));
    this.right.set(Math.cos(yaw), 0, -Math.sin(yaw));

    const p = this.camera.position;
    const step = this.speed * dt;
    p.x += (this.fwd.x * mz + this.right.x * mx) * step;
    p.z += (this.fwd.z * mz + this.right.z * mx) * step;
    p.x = Math.max(-this.bound, Math.min(this.bound, p.x));
    p.z = Math.max(-this.bound, Math.min(this.bound, p.z));
    p.y = this.heightAt(p.x, p.z) + this.eyeHeight;

    this.camera.quaternion.setFromEuler(this.euler);
  }
}
