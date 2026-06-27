/**
 * Instanced grass patch for the mobile scene. A tiny tapered-blade geometry
 * (replicated locally so we don't import GroundCover.ts, which pulls in
 * three/webgpu) instanced thousands of times with per-blade yaw/scale/hue and
 * a cheap vertex-shader wind sway.
 */

import {
  BufferAttribute,
  BufferGeometry,
  Color,
  DoubleSide,
  InstancedMesh,
  Matrix4,
  MeshStandardMaterial,
  Quaternion,
  Vector3,
} from 'three';
import type { Rng } from '../core/Seed';

function grassBladeGeometry(seg = 4, height = 0.55, width = 0.075): BufferGeometry {
  const pos: number[] = [];
  const nrm: number[] = [];
  const idx: number[] = [];
  for (let i = 0; i <= seg; i++) {
    const t = i / seg;
    const y = t * height;
    const w = width * (1 - t * 0.85) * 0.5; // taper toward the tip
    const bend = t * t * 0.12; // gentle forward arc
    pos.push(-w, y, bend, w, y, bend);
    // normals point mostly UP so blades read as a bright lit lawn rather than
    // dark edge-on slivers (a touch of +z keeps some form)
    nrm.push(0, 0.92, 0.39, 0, 0.92, 0.39);
  }
  for (let i = 0; i < seg; i++) {
    const a = i * 2;
    idx.push(a, a + 1, a + 3, a, a + 3, a + 2);
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
  g.setAttribute('normal', new BufferAttribute(new Float32Array(nrm), 3));
  g.setIndex(idx);
  return g;
}

export interface GrassPatch {
  mesh: InstancedMesh;
  setWind: (t: number) => void;
}

export function buildGrass(
  rng: Rng,
  heightAt: (x: number, z: number) => number,
  opts?: { count?: number; radius?: number },
): GrassPatch {
  const count = opts?.count ?? 40000;
  const radius = opts?.radius ?? 32;
  const geo = grassBladeGeometry(4);
  const mat = new MeshStandardMaterial({
    color: 0x6f9a3e,
    roughness: 0.95,
    metalness: 0,
    side: DoubleSide,
  });
  const windU = { value: 0 };
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uWind = windU;
    shader.vertexShader =
      'uniform float uWind;\n' +
      shader.vertexShader.replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        #ifdef USE_INSTANCING
          float ph = instanceMatrix[3].x + instanceMatrix[3].z;
        #else
          float ph = 0.0;
        #endif
        transformed.x += sin(uWind + ph) * 0.18 * max(position.y, 0.0);`,
      );
  };

  const mesh = new InstancedMesh(geo, mat, count);
  mesh.castShadow = false;
  mesh.receiveShadow = true;

  const m = new Matrix4();
  const q = new Quaternion();
  const up = new Vector3(0, 1, 0);
  const p = new Vector3();
  const s = new Vector3();
  const col = new Color();
  for (let i = 0; i < count; i++) {
    const a = rng.float() * Math.PI * 2;
    const r = Math.sqrt(rng.float()) * radius;
    const x = Math.cos(a) * r;
    const z = Math.sin(a) * r;
    p.set(x, heightAt(x, z), z);
    q.setFromAxisAngle(up, rng.float() * Math.PI * 2);
    const sc = 0.75 + rng.float() * 0.7;
    s.set(sc, sc * (0.85 + rng.float() * 0.6), sc);
    m.compose(p, q, s);
    mesh.setMatrixAt(i, m);
    const dry = rng.float() * 0.3;
    col.setRGB(0.42 + dry, 0.62 - dry * 0.32, 0.24);
    mesh.setColorAt(i, col);
  }
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;

  return { mesh, setWind: (t: number) => (windU.value = t) };
}
