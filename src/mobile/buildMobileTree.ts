/**
 * Pure-three tree builder for the mobile (WebGL2) scene. Mirrors the lod-0,
 * foliageMode:'mesh' path of the WebGPU TreeBuilder (src/vegetation/TreeBuilder.ts)
 * but imports ONLY the pure-three modules (Skeleton/TubeMesh/LeafMesh) — it
 * deliberately avoids TreeBuilder/FoliageCards, which pull in three/webgpu.
 * Budgeted low-poly: fewer ring segments and strided leaf anchors.
 */

import { Vector3 } from 'three';
import type { BufferGeometry } from 'three';
import type { Rng } from '../core/Seed';
import type { SpeciesParams } from '../vegetation/VegTypes';
import { growSkeleton } from '../vegetation/Skeleton';
import { MeshGrower, tubesForSkeleton } from '../vegetation/TubeMesh';
import { buildLeafCluster, buildSprayAt } from '../vegetation/LeafMesh';

export interface MobileTree {
  bark: BufferGeometry;
  foliage: BufferGeometry | null;
  tris: number;
  height: number;
}

export function buildMobileTree(
  sp: SpeciesParams,
  rng: Rng,
  opts?: { barkK?: number; meshAnchorTarget?: number },
): MobileTree {
  const barkK = opts?.barkK ?? 0.42;
  const meshAnchorTarget = opts?.meshAnchorTarget ?? 300;
  const skel = growSkeleton(sp, rng);

  // bark / branch tubes (low ring count via lodK)
  const barkG = new MeshGrower();
  tubesForSkeleton(barkG, skel, rng.fork('tubes'), {
    lodK: barkK,
    uRepeats: sp.barkRepeats,
    flare: { ...sp.flare, phase: rng.float() * Math.PI * 2 },
    maxLevel: 99,
    branchStride: 1,
  });
  let tris = barkG.triCount;
  const bark = barkG.build();

  // real mesh leaves at a strided subset of anchors (keeps the count bounded)
  let foliage: BufferGeometry | null = null;
  if (sp.foliage && skel.anchors.length > 0) {
    const fol = sp.foliage;
    const folG = new MeshGrower();
    const folRng = rng.fork('foliageMesh');
    const stride = Math.max(1, Math.ceil(skel.anchors.length / meshAnchorTarget));
    const anchors = stride > 1 ? skel.anchors.filter((_, i) => i % stride === 0) : skel.anchors;
    for (const a of anchors) {
      if (fol.kind === 'needleSpray') buildSprayAt(folG, a, fol.leaf, folRng);
      else buildLeafCluster(folG, a, fol.leaf, fol.clusterSize, folRng);
    }
    const crownC = new Vector3(0, skel.crownCenterY, 0);
    const crownR = Math.max(skel.crownRadius, (skel.height - skel.crownCenterY) * 0.9);
    folG.bendNormals(crownC, crownR, fol.normalBend);
    folG.crownAO(crownC, crownR, 0.55);
    tris += folG.triCount;
    foliage = folG.build();
  }

  return { bark, foliage, tris, height: skel.height };
}
