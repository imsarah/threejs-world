/**
 * Assembles the lightweight mobile world: gradient sky + fog, hemisphere + sun
 * light (one shadow), a small displaced terrain, ~100 instanced low-poly trees,
 * an instanced grass patch, and a few rocks. Plain three.js / WebGL2 — no
 * WebGPU, no compute. Deterministic from a single seed.
 */

import {
  BackSide,
  BufferAttribute,
  Color,
  DirectionalLight,
  DoubleSide,
  Fog,
  HemisphereLight,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PMREMGenerator,
  Quaternion,
  Scene,
  SphereGeometry,
  Vector3,
} from 'three';
import type { WebGLRenderer } from 'three';
import { Rng } from '../core/Seed';
import { BEECH, BIRCH, PINE, SPRUCE } from '../vegetation/Species';
import { buildRock } from '../vegetation/RockBuilder';
import type { RockPreset } from '../vegetation/RockBuilder';
import { buildTerrain } from './terrain';
import { buildMobileTree } from './buildMobileTree';
import { buildGrass } from './grass';

export interface MobileWorld {
  scene: Scene;
  heightAt: (x: number, z: number) => number;
  bound: number;
  update: (t: number) => void;
}

const SPECIES_SET = [
  { sp: SPRUCE, bark: 0x3f3328, leaf: 0x2f5236 },
  { sp: SPRUCE, bark: 0x3f3328, leaf: 0x355c3c },
  { sp: PINE, bark: 0x5a4530, leaf: 0x3c6b46 },
  { sp: BEECH, bark: 0x6a5d4c, leaf: 0x4f7a36 },
  { sp: BEECH, bark: 0x6a5d4c, leaf: 0x578139 },
  { sp: BIRCH, bark: 0xcfc8ba, leaf: 0x6f9a44 },
];

function buildSky(horizon: Color): Mesh {
  const geo = new SphereGeometry(380, 16, 12);
  const top = new Color(0x4a78b0);
  const pos = geo.attributes.position;
  const colors = new Float32Array(pos.count * 3);
  const c = new Color();
  for (let i = 0; i < pos.count; i++) {
    const t = Math.max(0, pos.getY(i) / 380);
    c.copy(horizon).lerp(top, t);
    colors[i * 3] = c.r;
    colors[i * 3 + 1] = c.g;
    colors[i * 3 + 2] = c.b;
  }
  geo.setAttribute('color', new BufferAttribute(colors, 3));
  const mat = new MeshBasicMaterial({ vertexColors: true, side: BackSide, fog: false });
  return new Mesh(geo, mat);
}

function scatterTrees(
  scene: Scene,
  rng: Rng,
  heightAt: (x: number, z: number) => number,
): void {
  const protos = SPECIES_SET.map((e, i) => ({
    ...e,
    tree: buildMobileTree(e.sp, rng.fork(`proto${i}`), { barkK: 0.5, meshAnchorTarget: 420 }),
  }));

  const TOTAL = 90;
  const CLEARING = 6;
  const SPREAD = 38;
  const counts = new Array(protos.length).fill(0);
  const insts: { i: number; m: Matrix4 }[] = [];
  const m = new Matrix4();
  const q = new Quaternion();
  const up = new Vector3(0, 1, 0);
  const p = new Vector3();
  const s = new Vector3();
  for (let n = 0; n < TOTAL; n++) {
    const a = rng.float() * Math.PI * 2;
    const r = CLEARING + Math.sqrt(rng.float()) * SPREAD;
    const x = Math.cos(a) * r;
    const z = Math.sin(a) * r;
    const pi = rng.int(protos.length);
    p.set(x, heightAt(x, z), z);
    q.setFromAxisAngle(up, rng.float() * Math.PI * 2);
    const sc = 0.8 + rng.float() * 0.5;
    s.set(sc, sc, sc);
    m.compose(p, q, s);
    insts.push({ i: pi, m: m.clone() });
    counts[pi]++;
  }

  for (let pi = 0; pi < protos.length; pi++) {
    const proto = protos[pi];
    const n = counts[pi];
    if (!proto || n === 0) continue;
    const barkMat = new MeshStandardMaterial({ color: proto.bark, roughness: 0.95, metalness: 0 });
    const barkMesh = new InstancedMesh(proto.tree.bark, barkMat, n);
    barkMesh.castShadow = true;
    barkMesh.receiveShadow = true;
    let folMesh: InstancedMesh | null = null;
    if (proto.tree.foliage) {
      const folMat = new MeshStandardMaterial({
        color: proto.leaf,
        roughness: 0.85,
        metalness: 0,
        side: DoubleSide,
      });
      folMesh = new InstancedMesh(proto.tree.foliage, folMat, n);
      folMesh.castShadow = true;
      folMesh.receiveShadow = true;
    }
    let k = 0;
    for (const inst of insts) {
      if (inst.i !== pi) continue;
      barkMesh.setMatrixAt(k, inst.m);
      if (folMesh) folMesh.setMatrixAt(k, inst.m);
      k++;
    }
    barkMesh.instanceMatrix.needsUpdate = true;
    scene.add(barkMesh);
    if (folMesh) {
      folMesh.instanceMatrix.needsUpdate = true;
      scene.add(folMesh);
    }
  }
}

function scatterRocks(
  scene: Scene,
  rng: Rng,
  heightAt: (x: number, z: number) => number,
): void {
  const presets: RockPreset[] = ['boulder', 'slab', 'cobble'];
  for (let i = 0; i < 6; i++) {
    const preset = presets[rng.int(presets.length)] ?? 'boulder';
    const built = buildRock(preset, rng.fork(`rock${i}`), 3);
    const mat = new MeshStandardMaterial({ color: 0x6d6a66, roughness: 1, metalness: 0 });
    const mesh = new Mesh(built.geometry, mat);
    const a = rng.float() * Math.PI * 2;
    const r = 4 + Math.sqrt(rng.float()) * 34;
    const x = Math.cos(a) * r;
    const z = Math.sin(a) * r;
    mesh.position.set(x, heightAt(x, z), z);
    mesh.scale.setScalar(0.5 + rng.float() * 1.1);
    mesh.rotation.y = rng.float() * Math.PI * 2;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    scene.add(mesh);
  }
}

export function buildMobileWorld(renderer: WebGLRenderer, seed = 1337): MobileWorld {
  const scene = new Scene();
  const horizon = new Color(0x9fb8c8);
  scene.background = horizon.clone();
  scene.fog = new Fog(horizon.getHex(), 22, 80);
  scene.add(buildSky(horizon));

  // image-based lighting: prefilter the gradient sky into an environment map so
  // the PBR materials pick up soft sky/ground ambient (the single biggest
  // quality jump available without a post stack)
  const pmrem = new PMREMGenerator(renderer);
  const envScene = new Scene();
  envScene.add(buildSky(horizon));
  scene.environment = pmrem.fromScene(envScene, 0, 1, 1000).texture;
  pmrem.dispose();

  scene.add(new HemisphereLight(0xbcd3e0, 0x49402f, 0.55));
  const sun = new DirectionalLight(0xfff2dc, 2.7);
  sun.position.set(34, 52, 22);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048); // crisper shadows over the smaller arena
  const sc = sun.shadow.camera;
  sc.left = -46;
  sc.right = 46;
  sc.top = 46;
  sc.bottom = -46;
  sc.near = 1;
  sc.far = 150;
  sun.shadow.bias = -0.0003;
  sun.shadow.normalBias = 0.02;
  scene.add(sun);
  scene.add(sun.target);

  const terrain = buildTerrain();
  scene.add(terrain.mesh);
  const heightAt = terrain.heightAt;

  const rng = new Rng(seed);
  scatterTrees(scene, rng.fork('trees'), heightAt);
  const grass = buildGrass(rng.fork('grass'), heightAt, { count: 40000, radius: 32 });
  scene.add(grass.mesh);
  scatterRocks(scene, rng.fork('rocks'), heightAt);

  return {
    scene,
    heightAt,
    bound: terrain.half - 3,
    update: (t: number) => grass.setWind(t),
  };
}
