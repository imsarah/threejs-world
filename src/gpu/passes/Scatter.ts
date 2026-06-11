/**
 * Scatter — GPU vegetation/rock placement (spec §3.5), boot-time.
 *
 * Clustered Poisson, fully parallel: a jittered child grid (one thread per
 * candidate cell) is gated by per-class density functions (biome, slope,
 * altitude/treeline, moisture, snow, rock exposure, water) × a parent clump
 * field (hashed parent points per coarse cell → light-competition clumping;
 * the SAME parent field feeds the understory pass as a canopy proxy: ferns
 * gather under tree clumps, flowers in gaps, pink shrubs at clump edges).
 * Ecotones: the biome id is read through a low-frequency warp so boundaries
 * interdigitate instead of tracing classification isolines.
 *
 * Accepted instances are atomically appended into storage buffers — instance
 * data never touches the CPU (only the final counts are read back once for
 * HUD/draw bookkeeping). Deterministic: all randomness is pcg2d(cell, salt),
 * an integer hash — sin-based hashes band at 4-digit cell coordinates.
 *
 * Instance layout (two vec4 buffers):
 *   A = (x, y, z, scale)
 *   B = (yaw, leanX, leanZ, idF)   idF = class·8 + variant  (exact in f32)
 */

import type { Renderer } from 'three/webgpu';
import type { StorageBufferNode } from 'three/webgpu';
import {
  Fn,
  If,
  Return,
  atomicAdd,
  float,
  instanceIndex,
  instancedArray,
  int,
  smoothstep,
  texture,
  uint,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import type { WorldSeed } from '../../core/Seed';
import type { Heightfield } from '../../world/Heightfield';
import { LAKE_LEVEL, TREELINE, WORLD_SIZE } from '../../world/WorldConst';
import { fbm3 } from '../noise/NoiseTSL';
import type { NF, NI, NU, NV2, NV4 } from '../TSLTypes';

/** geometry-pool class ids (variant index lives in the low 3 bits of idF) */
export const enum VegClass {
  // trees — order matches TREE_SPECIES
  Spruce = 0,
  Pine = 1,
  Beech = 2,
  Birch = 3,
  KarstGnarl = 4,
  Snag = 5,
  // understory
  BushHazel = 8,
  BushPink = 9,
  Juniper = 10,
  Fern = 11,
  FlowerUmbel = 12,
  FlowerBell = 13,
  FlowerDaisy = 14,
  // ground extras
  Log = 16,
  Stump = 17,
  Boulder = 18,
  Slab = 19,
}

/** structural variants baked per tree species (geometry reuse, D5) */
export const TREE_VARIANTS = 4;

export interface ScatterLayer {
  bufA: StorageBufferNode<'vec4'>;
  bufB: StorageBufferNode<'vec4'>;
  cap: number;
  /** accepted instances (clamped to cap) — read back once at boot */
  count: number;
}

export interface ScatterResult {
  trees: ScatterLayer;
  understory: ScatterLayer;
  extras: ScatterLayer;
}

// child-grid cell sizes (m) — jitter spans the full cell, so no grid reads
const TREE_CELL = 3.4;
const UNDER_CELL = 2.4;
const EXTRA_CELL = 7;
const TREE_CAP = 600_000;
const UNDER_CAP = 700_000;
const EXTRA_CAP = 90_000;

// parent clump field (shared by trees + understory — canopy correlation)
const PARENT_CELL = 26;
const PARENT_PROB = 0.62;

const TAU = 6.2831853;

// ---------------------------------------------------------------------------
// integer hash: pcg2d over (cell + salt) — stable at any cell magnitude
// ---------------------------------------------------------------------------

function pcg2d(p: NV2, salt: number): NV2 {
  // cells are non-negative grid coords; +1024 guards small negatives
  const vx = p.x.add(1024 + (salt & 0xffff)).toUint().toVar();
  const vy = p.y.add(1024 + ((salt >> 16) & 0xffff)).toUint().toVar();
  const M = uint(1664525);
  const C = uint(1013904223);
  vx.assign(vx.mul(M).add(C));
  vy.assign(vy.mul(M).add(C));
  vx.addAssign(vy.mul(M));
  vy.addAssign(vx.mul(M));
  vx.assign(vx.bitXor(vx.shiftRight(uint(16))));
  vy.assign(vy.bitXor(vy.shiftRight(uint(16))));
  vx.addAssign(vy.mul(M));
  vy.addAssign(vx.mul(M));
  vx.assign(vx.bitXor(vx.shiftRight(uint(16))));
  vy.assign(vy.bitXor(vy.shiftRight(uint(16))));
  const inv = 1 / 16777216;
  return vec2(
    float(vx.bitAnd(uint(0xffffff))).mul(inv),
    float(vy.bitAnd(uint(0xffffff))).mul(inv),
  );
}

function cellHash2(cell: NV2, salt: number): NV2 {
  return pcg2d(cell, salt);
}

function cellHash(cell: NV2, salt: number): NF {
  return pcg2d(cell, salt).x;
}

// ---------------------------------------------------------------------------

/** per-biome value tables → TSL select chain (biome ids 0..5) */
function byBiome(bioId: NI, vals: readonly number[]): NF {
  let e: NF = float(vals[5] ?? 0);
  for (let b = 4; b >= 0; b--) {
    e = bioId.equal(int(b)).select(float(vals[b] ?? 0), e) as NF;
  }
  return e;
}

/**
 * Parent clump field: hashed parent points on a coarse grid; weight = max
 * kernel over the 3×3 neighborhood. ~1 at clump hearts, 0 in gaps.
 */
function clumpField(wpos: NV2, salt: number): NF {
  const base = wpos.div(PARENT_CELL).floor();
  const w = float(0).toVar();
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const c = base.add(vec2(dx, dy)).add(8192); // parents span negatives
      const h2 = cellHash2(c, salt);
      const exists = cellHash(c, salt ^ 0x9e3779).lessThan(PARENT_PROB);
      const ppos = c.sub(8192).add(0.15).add(h2.mul(0.7)).mul(PARENT_CELL);
      const r = float(PARENT_CELL).mul(h2.x.mul(0.55).add(0.5));
      const d = wpos.sub(ppos).length();
      const k = float(1)
        .sub(smoothstep(r.mul(0.22), r, d))
        .mul(exists.select(float(1), float(0)));
      w.assign(w.max(k));
    }
  }
  return w;
}

interface SiteSamples {
  h: NF;
  slope: NF;
  bioId: NI; // ecotone-warped biome id
  snow: NF;
  vegDens: NF;
  rockExp: NF;
  moisture: NF;
  riverDepth: NF;
  standing: NF; // W − h (standing-water depth)
  nrmXZ: NV2;
}

function sampleSite(hf: Heightfield, wpos: NV2): SiteSamples {
  const uv = wpos.div(WORLD_SIZE).add(0.5);
  const h = hf.sampleHeight(wpos);
  const ns = texture(hf.normalTex, uv, 0) as unknown as NV4;
  // ecotone warp: read the biome classification through a ±26 m wobble
  const warp = vec2(
    fbm3(vec3(wpos.x.mul(0.011), 3.7, wpos.y.mul(0.011)), 2),
    fbm3(vec3(wpos.x.mul(0.011), 91.2, wpos.y.mul(0.011)), 2),
  ).mul(26);
  const uvW = wpos.add(warp).div(WORLD_SIZE).add(0.5);
  const bio = texture(
    hf.biomeTex as NonNullable<typeof hf.biomeTex>,
    uvW,
    0,
  ) as unknown as NV4;
  const bioExact = texture(
    hf.biomeTex as NonNullable<typeof hf.biomeTex>,
    uv,
    0,
  ) as unknown as NV4;
  const fields = texture(
    hf.fieldsTex as NonNullable<typeof hf.fieldsTex>,
    uv,
    0,
  ) as unknown as NV4;
  return {
    h,
    slope: ns.w,
    bioId: bio.x.mul(8).add(0.5).floor().toInt(),
    snow: bioExact.y, // snow/veg-density/rock read unwarped (physical fields)
    vegDens: bioExact.z,
    rockExp: bioExact.w,
    moisture: fields.x,
    riverDepth: fields.z,
    standing: fields.w.sub(h),
    nrmXZ: vec2(ns.x, ns.z),
  };
}

type AtomicCounter = ReturnType<StorageBufferNode<'uint'>['toAtomic']>;

/** append helper: idx = old counter value; write when under cap */
function append(
  counter: AtomicCounter,
  cap: number,
  bufA: StorageBufferNode<'vec4'>,
  bufB: StorageBufferNode<'vec4'>,
  a: NV4,
  b: NV4,
): void {
  const idx = atomicAdd(counter.element(0), uint(1)) as unknown as NU;
  If(idx.lessThan(uint(cap)), () => {
    bufA.element(idx).assign(a);
    bufB.element(idx).assign(b);
  });
}

async function readCount(
  renderer: Renderer,
  counter: AtomicCounter,
  cap: number,
): Promise<number> {
  const attr = (counter as unknown as { value: unknown }).value;
  const ab = await renderer.getArrayBufferAsync(
    attr as Parameters<Renderer['getArrayBufferAsync']>[0],
  );
  const n = new Uint32Array(ab)[0] ?? 0;
  return Math.min(n, cap);
}

export async function runScatter(
  renderer: Renderer,
  hf: Heightfield,
  seed: WorldSeed,
): Promise<ScatterResult> {
  const sT = seed.sub('scatter/trees') & 0x7fffffff;
  const sU = seed.sub('scatter/understory') & 0x7fffffff;
  const sE = seed.sub('scatter/extras') & 0x7fffffff;

  // ---------------------------------------------------------------- trees --
  const treeG = Math.round(WORLD_SIZE / TREE_CELL);
  const treeA = instancedArray(TREE_CAP, 'vec4');
  const treeB = instancedArray(TREE_CAP, 'vec4');
  const treeCount = instancedArray(1, 'uint').toAtomic();

  const treeK = Fn(() => {
    const i = instanceIndex;
    If(i.greaterThanEqual(treeG * treeG), () => {
      Return();
    });
    const cell = vec2(float(i.mod(treeG)), float(i.div(treeG)));
    const jit = cellHash2(cell, sT);
    const wpos = cell.add(jit).div(treeG).sub(0.5).mul(WORLD_SIZE);
    const s = sampleSite(hf, wpos);

    // hard exclusions: open/standing water, river channels, lake shelf
    If(s.h.lessThan(LAKE_LEVEL + 0.4), () => {
      Return();
    });
    If(s.riverDepth.greaterThan(0.03).or(s.standing.greaterThan(0.12)), () => {
      Return();
    });

    const clump = clumpField(wpos, sT ^ 0x51f3);
    const dens = byBiome(s.bioId, [0, 0.18, 0.72, 0.78, 0.045, 0.22]);
    const clumpFloor = byBiome(s.bioId, [0, 0.15, 0.3, 0.35, 0.04, 0.12]);
    const slopeFade = float(1).sub(smoothstep(0.5, 0.95, s.slope));
    const treelineFade = float(1).sub(
      smoothstep(TREELINE - 110, TREELINE + 50, s.h),
    );
    const snowFade = float(1).sub(s.snow.mul(0.85));
    const accept = dens
      .mul(clumpFloor.add(float(1).sub(clumpFloor).mul(clump)))
      .mul(slopeFade)
      .mul(treelineFade)
      .mul(snowFade)
      .mul(s.vegDens.mul(0.85).add(0.15))
      .mul(float(1).sub(s.rockExp.mul(0.8)));
    If(cellHash(cell, sT ^ 0x1234f).greaterThanEqual(accept), () => {
      Return();
    });

    // species weights: per-biome table × moisture response
    const m = s.moisture;
    const w0 = byBiome(s.bioId, [0, 0.6, 0.58, 0.07, 0.05, 0.12]) // spruce
      .mul(m.mul(0.5).add(0.75));
    const w1 = byBiome(s.bioId, [0, 0.22, 0.27, 0.02, 0.15, 0]) // pine
      .mul(float(1.45).sub(m.mul(0.9)));
    const w2 = byBiome(s.bioId, [0, 0, 0.02, 0.5, 0.42, 0.05]) // beech
      .mul(m.mul(0.9).add(0.55));
    const w3 = byBiome(s.bioId, [0, 0.03, 0.08, 0.16, 0.3, 0.55]) // birch
      .mul(m.mul(0.6).add(0.7));
    const w4 = byBiome(s.bioId, [0, 0, 0, 0.2, 0, 0]) // karst gnarl
      .mul(s.rockExp.mul(1.6).add(0.4));
    const w5 = byBiome(s.bioId, [0, 0.15, 0.05, 0.05, 0.08, 0.28]); // snag

    const r = cellHash(cell, sT ^ 0x77e1).mul(
      w0.add(w1).add(w2).add(w3).add(w4).add(w5),
    );
    const sp = int(0).toVar();
    const acc = w0.toVar();
    If(r.greaterThan(acc), () => {
      sp.assign(1);
      acc.addAssign(w1);
      If(r.greaterThan(acc), () => {
        sp.assign(2);
        acc.addAssign(w2);
        If(r.greaterThan(acc), () => {
          sp.assign(3);
          acc.addAssign(w3);
          If(r.greaterThan(acc), () => {
            sp.assign(4);
            acc.addAssign(w4);
            If(r.greaterThan(acc), () => {
              sp.assign(5);
            });
          });
        });
      });
    });

    // size: power-biased jitter; krummholz shrink toward the treeline;
    // subalpine biome additionally stunted
    const h2 = cellHash2(cell, sT ^ 0x3b8d);
    const krumm = smoothstep(TREELINE - 170, TREELINE + 10, s.h);
    const stunt = s.bioId.equal(int(1)).select(float(0.72), float(1));
    const scale = h2.x
      .pow(1.6)
      .mul(0.85)
      .add(0.62)
      .mul(float(1).sub(krumm.mul(0.55)))
      .mul(stunt);

    const yaw = h2.y.mul(TAU);
    const leanR = cellHash2(cell, sT ^ 0x6c2f).sub(0.5).mul(0.12);
    const lean = s.nrmXZ.mul(0.18).add(leanR);
    const variant = cellHash(cell, sT ^ 0x49a1)
      .mul(TREE_VARIANTS)
      .floor()
      .min(TREE_VARIANTS - 1);
    const idF = float(sp).mul(8).add(variant);
    const y = s.h.sub(scale.mul(0.12)); // sink — root flare covers the seam

    append(
      treeCount,
      TREE_CAP,
      treeA,
      treeB,
      vec4(wpos.x, y, wpos.y, scale) as unknown as NV4,
      vec4(yaw, lean.x, lean.y, idF) as unknown as NV4,
    );
  })().compute(treeG * treeG);
  treeK.setName('scatterTrees');
  await renderer.computeAsync(treeK);

  // ----------------------------------------------------------- understory --
  const underG = Math.round(WORLD_SIZE / UNDER_CELL);
  const underA = instancedArray(UNDER_CAP, 'vec4');
  const underB = instancedArray(UNDER_CAP, 'vec4');
  const underCount = instancedArray(1, 'uint').toAtomic();

  const underK = Fn(() => {
    const i = instanceIndex;
    If(i.greaterThanEqual(underG * underG), () => {
      Return();
    });
    const cell = vec2(float(i.mod(underG)), float(i.div(underG)));
    const jit = cellHash2(cell, sU);
    const wpos = cell.add(jit).div(underG).sub(0.5).mul(WORLD_SIZE);
    const s = sampleSite(hf, wpos);

    If(s.h.lessThan(LAKE_LEVEL + 0.35), () => {
      Return();
    });
    If(s.riverDepth.greaterThan(0.02).or(s.standing.greaterThan(0.1)), () => {
      Return();
    });

    // canopy proxy = the TREE clump field (same salt → same parents)
    const canopy = clumpField(wpos, sT ^ 0x51f3);
    const dens = byBiome(s.bioId, [0, 0.25, 0.55, 0.6, 0.55, 0.45]);
    const slopeFade = float(1).sub(smoothstep(0.55, 0.9, s.slope));
    const treelineFade = float(1).sub(
      smoothstep(TREELINE - 40, TREELINE + 140, s.h),
    );
    const accept = dens
      .mul(slopeFade)
      .mul(treelineFade)
      .mul(float(1).sub(s.snow.mul(0.9)))
      .mul(s.vegDens.mul(0.9).add(0.1))
      .mul(float(1).sub(s.rockExp.mul(0.85)));
    If(cellHash(cell, sU ^ 0x2477).greaterThanEqual(accept), () => {
      Return();
    });

    const m = s.moisture;
    const edge = canopy.mul(float(1).sub(canopy)).mul(4); // 1 at clump rims
    const w0 = byBiome(s.bioId, [0, 0.05, 0.15, 0.3, 0.04, 0.1]); // hazel
    const w1 = byBiome(s.bioId, [0, 0, 0.02, 0.12, 0.1, 0.02]) // pink shrub
      .mul(edge.mul(1.3).add(0.2));
    const w2 = byBiome(s.bioId, [0, 0.55, 0.3, 0.02, 0.03, 0]) // juniper
      .mul(float(1.3).sub(m.mul(0.8)));
    const w3 = byBiome(s.bioId, [0, 0.1, 0.4, 0.38, 0.03, 0.5]) // fern
      .mul(m.mul(1.1).add(0.3))
      .mul(canopy.mul(1.1).add(0.35));
    const gapK = float(1.25).sub(canopy.mul(0.9));
    const w4 = byBiome(s.bioId, [0, 0.1, 0.05, 0.06, 0.3, 0.2]).mul(gapK); // umbel
    const w5 = byBiome(s.bioId, [0, 0.08, 0.04, 0.06, 0.22, 0.1]).mul(gapK); // bell
    const w6 = byBiome(s.bioId, [0, 0.12, 0.04, 0.06, 0.28, 0.08]).mul(gapK); // daisy

    const r = cellHash(cell, sU ^ 0x59d3).mul(
      w0.add(w1).add(w2).add(w3).add(w4).add(w5).add(w6),
    );
    const cls = int(VegClass.BushHazel).toVar();
    const acc = w0.toVar();
    If(r.greaterThan(acc), () => {
      cls.assign(int(VegClass.BushPink));
      acc.addAssign(w1);
      If(r.greaterThan(acc), () => {
        cls.assign(int(VegClass.Juniper));
        acc.addAssign(w2);
        If(r.greaterThan(acc), () => {
          cls.assign(int(VegClass.Fern));
          acc.addAssign(w3);
          If(r.greaterThan(acc), () => {
            cls.assign(int(VegClass.FlowerUmbel));
            acc.addAssign(w4);
            If(r.greaterThan(acc), () => {
              cls.assign(int(VegClass.FlowerBell));
              acc.addAssign(w5);
              If(r.greaterThan(acc), () => {
                cls.assign(int(VegClass.FlowerDaisy));
              });
            });
          });
        });
      });
    });

    const h2 = cellHash2(cell, sU ^ 0x71c9);
    const scale = h2.x.pow(1.4).mul(0.7).add(0.6);
    const yaw = h2.y.mul(TAU);
    const variant = cellHash(cell, sU ^ 0x1ee7).mul(4).floor().min(3);
    const idF = float(cls).mul(8).add(variant);

    append(
      underCount,
      UNDER_CAP,
      underA,
      underB,
      vec4(wpos.x, s.h.sub(0.03), wpos.y, scale) as unknown as NV4,
      vec4(yaw, 0, 0, idF) as unknown as NV4,
    );
  })().compute(underG * underG);
  underK.setName('scatterUnderstory');
  await renderer.computeAsync(underK);

  // --------------------------------------------------------------- extras --
  const extraG = Math.round(WORLD_SIZE / EXTRA_CELL);
  const extraA = instancedArray(EXTRA_CAP, 'vec4');
  const extraB = instancedArray(EXTRA_CAP, 'vec4');
  const extraCount = instancedArray(1, 'uint').toAtomic();

  const extraK = Fn(() => {
    const i = instanceIndex;
    If(i.greaterThanEqual(extraG * extraG), () => {
      Return();
    });
    const cell = vec2(float(i.mod(extraG)), float(i.div(extraG)));
    const jit = cellHash2(cell, sE);
    const wpos = cell.add(jit).div(extraG).sub(0.5).mul(WORLD_SIZE);
    const s = sampleSite(hf, wpos);

    If(s.h.lessThan(LAKE_LEVEL + 0.3), () => {
      Return();
    });
    If(s.riverDepth.greaterThan(0.05).or(s.standing.greaterThan(0.15)), () => {
      Return();
    });

    const canopy = clumpField(wpos, sT ^ 0x51f3);
    const forestK = byBiome(s.bioId, [0, 0.3, 1, 1, 0.25, 0.6]).mul(
      canopy.mul(0.7).add(0.3),
    );
    const m = s.moisture;
    const w0 = forestK.mul(0.3).mul(m.mul(0.6).add(0.4)); // log
    const w1 = forestK.mul(0.12); // stump
    const w2 = s.rockExp.mul(1.1).add(0.12).mul(0.42); // boulder
    const w3 = s.rockExp.mul(0.9).mul(0.2); // slab

    const dens = byBiome(s.bioId, [0.04, 0.12, 0.3, 0.32, 0.1, 0.25]);
    const slopeFade = float(1).sub(smoothstep(0.55, 1.1, s.slope));
    const wSum = w0.add(w1).add(w2).add(w3);
    const accept = dens.mul(slopeFade).mul(wSum.min(1));
    If(cellHash(cell, sE ^ 0x3f21).greaterThanEqual(accept), () => {
      Return();
    });

    const r = cellHash(cell, sE ^ 0x6d05).mul(wSum);
    const cls = int(VegClass.Log).toVar();
    const acc = w0.toVar();
    If(r.greaterThan(acc), () => {
      cls.assign(int(VegClass.Stump));
      acc.addAssign(w1);
      If(r.greaterThan(acc), () => {
        cls.assign(int(VegClass.Boulder));
        acc.addAssign(w2);
        If(r.greaterThan(acc), () => {
          cls.assign(int(VegClass.Slab));
        });
      });
    });

    // logs slide off steep ground; decay class follows moisture
    If(cls.equal(int(VegClass.Log)).and(s.slope.greaterThan(0.5)), () => {
      Return();
    });
    const h2 = cellHash2(cell, sE ^ 0x15bd);
    const mJit = m.add(h2.x.mul(0.3).sub(0.15));
    const decay = mJit
      .greaterThan(0.62)
      .select(float(2), mJit.greaterThan(0.35).select(float(1), float(0)));
    const variant = cls
      .equal(int(VegClass.Log))
      .select(decay, cellHash(cell, sE ^ 0x44d7).mul(4).floor().min(3));

    const isRock = cls.greaterThanEqual(int(VegClass.Boulder));
    const scale = isRock.select(
      h2.y.pow(2).mul(1.9).add(0.5),
      h2.y.mul(0.6).add(0.7),
    );
    const sink = isRock.select(scale.mul(0.28), float(0.08));
    const yaw = cellHash(cell, sE ^ 0x2a6b).mul(TAU);
    const idF = float(cls).mul(8).add(variant);

    append(
      extraCount,
      EXTRA_CAP,
      extraA,
      extraB,
      vec4(wpos.x, s.h.sub(sink), wpos.y, scale) as unknown as NV4,
      vec4(yaw, s.nrmXZ.x.mul(0.3), s.nrmXZ.y.mul(0.3), idF) as unknown as NV4,
    );
  })().compute(extraG * extraG);
  extraK.setName('scatterExtras');
  await renderer.computeAsync(extraK);

  // ---- counts (single boot-time readback; instance data stays on GPU) ----
  const [tc, uc, ec] = await Promise.all([
    readCount(renderer, treeCount, TREE_CAP),
    readCount(renderer, underCount, UNDER_CAP),
    readCount(renderer, extraCount, EXTRA_CAP),
  ]);

  return {
    trees: { bufA: treeA, bufB: treeB, cap: TREE_CAP, count: tc },
    understory: { bufA: underA, bufB: underB, cap: UNDER_CAP, count: uc },
    extras: { bufA: extraA, bufB: extraB, cap: EXTRA_CAP, count: ec },
  };
}
