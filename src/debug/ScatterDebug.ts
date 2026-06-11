/**
 * ?view=scatter — instanced marker view of the GPU scatter buffers.
 * Cones = trees (sized by species height × instance scale), boxes =
 * understory/extras, colored per class. Reads the instance buffers directly
 * (slot = instanceIndex; scatter output is compaction-dense).
 */

import { BoxGeometry, ConeGeometry, type Scene } from 'three';
import { InstancedMesh, MeshStandardNodeMaterial } from 'three/webgpu';
import { float, instanceIndex, positionLocal, varying, vec3 } from 'three/tsl';
import type { ScatterLayer, ScatterResult } from '../gpu/passes/Scatter';
import type { NF, NV3 } from '../gpu/TSLTypes';

/** select chain over class index (idF/8 − base) */
function byCls(cls: NF, base: number, vals: readonly number[]): NF {
  let e: NF = float(vals[vals.length - 1] ?? 0);
  for (let c = vals.length - 2; c >= 0; c--) {
    e = cls.equal(float(c + base)).select(float(vals[c] ?? 0), e) as NF;
  }
  return e;
}

function byClsColor(
  cls: NF,
  base: number,
  colors: readonly [number, number, number][],
): NV3 {
  const last = colors[colors.length - 1] ?? [1, 0, 1];
  let e: NV3 = vec3(...last);
  for (let c = colors.length - 2; c >= 0; c--) {
    const col = colors[c] ?? [1, 0, 1];
    e = cls.equal(float(c + base)).select(vec3(...col), e) as NV3;
  }
  return e;
}

function markerMesh(
  layer: ScatterLayer,
  geo: BoxGeometry | ConeGeometry,
  base: number,
  heights: readonly number[],
  radii: readonly number[],
  colors: readonly [number, number, number][],
): InstancedMesh {
  const mat = new MeshStandardNodeMaterial();
  const A = layer.bufA.element(instanceIndex);
  const B = layer.bufB.element(instanceIndex);
  const cls = B.w.div(8).floor();
  const h = byCls(cls, base, heights).mul(A.w);
  const r = byCls(cls, base, radii).mul(A.w);
  // marker geometry is centered: lift to base, scale, place
  mat.positionNode = positionLocal
    .add(vec3(0, 0.5, 0))
    .mul(vec3(r, h, r))
    .add(A.xyz);
  mat.colorNode = varying(byClsColor(cls, base, colors));
  mat.roughness = 0.95;
  const mesh = new InstancedMesh(geo, mat, Math.max(layer.count, 1));
  mesh.frustumCulled = false;
  mesh.visible = layer.count > 0;
  return mesh;
}

export function addScatterDebug(scene: Scene, scatter: ScatterResult): void {
  const cone = new ConeGeometry(0.5, 1, 5);
  const box = new BoxGeometry(1, 1, 1);

  scene.add(
    markerMesh(
      scatter.trees,
      cone,
      0,
      [21, 17, 15, 13, 7, 11],
      [6.5, 6.5, 9, 7, 8, 2.2],
      [
        [0.05, 0.16, 0.06], // spruce
        [0.12, 0.2, 0.08], // pine
        [0.16, 0.34, 0.08], // beech
        [0.3, 0.4, 0.1], // birch
        [0.07, 0.26, 0.09], // karst gnarl
        [0.35, 0.28, 0.2], // snag
      ],
    ),
  );
  scene.add(
    markerMesh(
      scatter.understory,
      box,
      8,
      [1.6, 1.3, 1.0, 0.8, 0.5, 0.45, 0.4],
      [1.8, 1.5, 1.2, 1.1, 0.5, 0.45, 0.4],
      [
        [0.14, 0.3, 0.1], // hazel
        [0.75, 0.2, 0.35], // pink shrub
        [0.1, 0.24, 0.12], // juniper
        [0.12, 0.42, 0.12], // fern
        [0.85, 0.85, 0.7], // umbel
        [0.45, 0.38, 0.8], // bell
        [0.9, 0.9, 0.8], // daisy
      ],
    ),
  );
  scene.add(
    markerMesh(
      scatter.extras,
      box,
      16,
      [0.7, 0.9, 1.4, 0.6],
      [3.2, 1.0, 1.6, 2.6],
      [
        [0.32, 0.24, 0.16], // log
        [0.26, 0.2, 0.13], // stump
        [0.5, 0.48, 0.45], // boulder
        [0.58, 0.56, 0.52], // slab
      ],
    ),
  );
}
