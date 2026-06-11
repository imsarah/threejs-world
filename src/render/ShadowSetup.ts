/**
 * Sun shadows: 4-cascade CSM (texel-snapped by CSMShadowNode) with a PCSS
 * contact-hardening filter — blocker search (raw depth) → penumbra estimate →
 * Vogel-disk PCF at the penumbra radius. Screen-space contact shadows live in
 * the post stack and pick up what cascade resolution can't.
 */

import type { DirectionalLight, PerspectiveCamera, Texture } from 'three';
import { CSMShadowNode } from 'three/addons/csm/CSMShadowNode.js';
import {
  Fn,
  If,
  float,
  interleavedGradientNoise,
  positionWorld,
  reference,
  screenCoordinate,
  texture,
  vogelDiskSample,
} from 'three/tsl';
import type { NF, NV2, NV4 } from '../gpu/TSLTypes';

const BLOCKER_TAPS = 6;
const PCF_TAPS = 9;
/** light angular size factor: penumbra growth per unit blocker–receiver gap */
const PENUMBRA_SCALE = 38;
const MAX_PENUMBRA_TEXELS = 14;

interface ShadowFilterInputs {
  depthTexture: Texture;
  shadowCoord: NV4;
  shadow: object;
  depthLayer: number;
}

/**
 * PCSS filter, same calling convention as three's built-in shadow filters.
 * NOTE: typed loosely — the harness passes a plain object at build time.
 */
export const pcssFilter = Fn((inputs: unknown) => {
  const { depthTexture, shadowCoord, shadow } = inputs as ShadowFilterInputs;
  const mapSize = reference('mapSize', 'vec2', shadow);
  const radius = reference('radius', 'float', shadow);
  const texel = float(1).div(mapSize.x);
  const phi = interleavedGradientNoise(screenCoordinate.xy).mul(6.28318530718);

  const receiver = shadowCoord.z;

  // --- blocker search (raw depth reads) -------------------------------------
  const searchR = texel.mul(6).mul(radius.max(1));
  const blockerSum = float(0).toVar();
  const blockerCount = float(0).toVar();
  for (let i = 0; i < BLOCKER_TAPS; i++) {
    const tap = vogelDiskSample(float(i), float(BLOCKER_TAPS), phi) as unknown as NV2;
    const uv = shadowCoord.xy.add(tap.mul(searchR));
    const d = texture(depthTexture, uv).x;
    const isBlocker = d.lessThan(receiver.sub(1e-4));
    blockerSum.addAssign(isBlocker.select(d, float(0)));
    blockerCount.addAssign(isBlocker.select(float(1), float(0)));
  }

  const result = float(1).toVar();
  If(blockerCount.greaterThan(0.5), () => {
    const avgBlocker = blockerSum.div(blockerCount);
    // orthographic cascades: penumbra ∝ depth gap
    const penumbra = receiver
      .sub(avgBlocker)
      .mul(PENUMBRA_SCALE)
      .clamp(0.75, MAX_PENUMBRA_TEXELS)
      .mul(texel)
      .mul(radius.max(1));
    const sum = float(0).toVar();
    for (let i = 0; i < PCF_TAPS; i++) {
      const tap = vogelDiskSample(float(i), float(PCF_TAPS), phi) as unknown as NV2;
      const uv = shadowCoord.xy.add(tap.mul(penumbra));
      sum.addAssign(texture(depthTexture, uv).compare(receiver) as unknown as NF);
    }
    result.assign(sum.div(PCF_TAPS));
  });
  return result;
});

export interface ShadowRig {
  csm: CSMShadowNode;
}

/**
 * @param cloudShadow optional world-space sun-transmittance factor (clouds):
 * multiplied into the filter result so it gates ONLY direct sun light.
 */
export function setupSunShadows(
  sun: DirectionalLight,
  camera: PerspectiveCamera,
  cloudShadow?: (wxz: NV2) => NF,
  opts?: { maxFar?: number; lightMargin?: number },
): ShadowRig {
  // perf attribution: ?ablate=shadows (no casting) | pcss (default filter)
  const ablate = new Set(
    (new URLSearchParams(window.location.search).get('ablate') ?? '').split(','),
  );
  if (ablate.has('shadows')) {
    sun.castShadow = false;
    return { csm: null as unknown as CSMShadowNode };
  }
  const maxFar = opts?.maxFar ?? 3200;
  const lightMargin = opts?.lightMargin ?? 700;
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.bias = -0.00012;
  sun.shadow.normalBias = 2.2;
  sun.shadow.radius = 1.15;
  // CSMShadowNode CLONES this shadow per cascade — its camera near/far are
  // inherited as the cascade depth range. The DirectionalLight default
  // (near .5, far 500) is shorter than the lightMargin alone, so every
  // cascade rendered an EMPTY map: zero shadows anywhere, no errors (the
  // official webgpu_shadowmap_csm example sets these explicitly).
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = lightMargin + maxFar * 2.2;

  if (!ablate.has('pcss')) {
    const filter = cloudShadow
      ? Fn((inputs: unknown) => {
          const base = (pcssFilter as unknown as (i: unknown) => NF)(inputs);
          return base.mul(cloudShadow(positionWorld.xz));
        })
      : pcssFilter;
    (sun.shadow as unknown as { filterNode: unknown }).filterNode = filter;
  }

  const csm = new CSMShadowNode(sun, {
    cascades: 4,
    maxFar,
    mode: 'practical',
    lightMargin,
  });
  csm.fade = true;
  (sun.shadow as unknown as { shadowNode: unknown }).shadowNode = csm;

  // CSMShadowNode contract: the APP must call updateFrustums() after camera
  // changes. Two traps bit us (no-shadows-anywhere, user-reported twice):
  // (1) its lazy _init samples camera.projectionMatrix at first material
  // build — under TRAA that matrix is mid-jitter (setViewOffset) and at boot
  // can be degenerate → NaN cascade extents cached forever; (2) nothing ever
  // recomputes them. Refresh with the jitter STRIPPED, verify the extents
  // came out finite, and retry until they do; re-run on resize.
  const extentsOk = (): boolean => {
    const l0 = (
      csm as unknown as { lights?: { shadow?: { camera?: { left?: number } } }[] }
    ).lights?.[0]?.shadow?.camera?.left;
    return typeof l0 === 'number' && Number.isFinite(l0);
  };
  const refresh = (): void => {
    const cam = (csm as unknown as { camera: PerspectiveCamera | null }).camera;
    if (!cam) return;
    // strip TRAA's per-frame jitter offset before deriving cascade frusta —
    // TRAA re-applies it on its next updateBefore
    if ((cam as unknown as { view?: { enabled?: boolean } }).view?.enabled) {
      cam.clearViewOffset();
    }
    cam.updateProjectionMatrix();
    csm.updateFrustums();
  };
  window.addEventListener('resize', refresh);
  const armRefresh = (): void => {
    refresh();
    if (!extentsOk()) requestAnimationFrame(armRefresh);
  };
  requestAnimationFrame(armRefresh);
  void camera;
  return { csm };
}
