/**
 * Mobile terrain — a small CPU value-noise heightfield baked into a displaced
 * plane (WebGL2, plain three). `heightAt` re-evaluates the same field so the
 * camera and scattered assets can sit on the ground without GPU readback.
 */

import { BufferAttribute, Color, Mesh, MeshStandardMaterial, PlaneGeometry } from 'three';

const SIZE = 96; // edge length (m) — compact mobile arena
const SEG = 112; // ~0.85 m quads for finer ground
const AMP = 3.0; // peak relief (m)

export const TERRAIN_HALF = SIZE / 2;

function hash2(ix: number, iz: number): number {
  let h = (Math.imul(ix, 374761393) + Math.imul(iz, 668265263)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177) | 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function valueNoise(x: number, z: number): number {
  const ix = Math.floor(x);
  const iz = Math.floor(z);
  const fx = x - ix;
  const fz = z - iz;
  const u = fx * fx * (3 - 2 * fx);
  const v = fz * fz * (3 - 2 * fz);
  const a = hash2(ix, iz);
  const b = hash2(ix + 1, iz);
  const c = hash2(ix, iz + 1);
  const d = hash2(ix + 1, iz + 1);
  return a * (1 - u) * (1 - v) + b * u * (1 - v) + c * (1 - u) * v + d * u * v;
}

/** ground height (m) at world (x,z) — two octaves, flattened near spawn */
export function terrainHeight(x: number, z: number): number {
  let h = valueNoise(x * 0.018, z * 0.018);
  h += valueNoise(x * 0.06 + 11.3, z * 0.06 + 7.7) * 0.32;
  h = (h / 1.32 - 0.5) * AMP;
  const d = Math.sqrt(x * x + z * z);
  const flat = Math.min(1, d / 8); // settle the immediate spawn clearing
  return h * (0.25 + 0.75 * flat);
}

export interface Terrain {
  mesh: Mesh;
  heightAt: (x: number, z: number) => number;
  half: number;
}

export function buildTerrain(): Terrain {
  const geo = new PlaneGeometry(SIZE, SIZE, SEG, SEG);
  geo.rotateX(-Math.PI / 2);
  const pos = geo.attributes.position;
  const colors = new Float32Array(pos.count * 3);
  const lo = new Color(0x3c5526); // meadow green (grass sits on top of this)
  const hi = new Color(0x6a6150); // rocky tan on the rises
  const tmp = new Color();
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const z = pos.getZ(i);
    const y = terrainHeight(x, z);
    pos.setY(i, y);
    const t = Math.min(1, Math.max(0, (y + AMP * 0.5) / (AMP * 1.5)));
    tmp.copy(lo).lerp(hi, t * t);
    // fine patchy mottle so the ground isn't a flat color slab
    const mottle = valueNoise(x * 0.13 + 31.7, z * 0.13 + 19.3) - 0.5;
    tmp.offsetHSL(mottle * 0.03, mottle * 0.1, mottle * 0.12);
    colors[i * 3] = tmp.r;
    colors[i * 3 + 1] = tmp.g;
    colors[i * 3 + 2] = tmp.b;
  }
  pos.needsUpdate = true;
  geo.setAttribute('color', new BufferAttribute(colors, 3));
  geo.computeVertexNormals();
  const mat = new MeshStandardMaterial({ vertexColors: true, roughness: 1, metalness: 0 });
  const mesh = new Mesh(geo, mat);
  mesh.receiveShadow = true;
  return { mesh, heightAt: terrainHeight, half: TERRAIN_HALF };
}
