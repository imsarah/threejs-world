/**
 * Biome + snow classification at full height resolution.
 * temperature(altitude, aspect) × moisture × slope × exposure → biome id,
 * snow coverage, vegetation density, rock exposure. Written as rgba8:
 *   r = biomeId / 8, g = snow 0..1, b = vegetation density, a = rock exposure
 *
 * Snow rules (Pillar/floors): altitude+temperature driven, fades on steep
 * slopes, bonus on sheltered north faces and on low-slope ledges (curvature),
 * dithered at the EDGE in the material (classification stores the smooth field).
 */

import { NearestFilter } from 'three';
import type { Renderer } from 'three/webgpu';
import { StorageTexture } from 'three/webgpu';
import {
  Fn,
  If,
  Return,
  clamp,
  float,
  instanceIndex,
  mix,
  mx_noise_float,
  smoothstep,
  texture,
  textureStore,
  uvec2,
  vec2,
  vec4,
} from 'three/tsl';
import { zoneMasksMini, type MacroParams } from '../../world/MacroMap';
import {
  Biome,
  LAKE_LEVEL,
  MACRO_ZOOM,
  TREELINE,
  WORLD_SCALE,
  WORLD_SIZE,
} from '../../world/WorldConst';
import type { FloatBuffer } from './HeightSynthesis';

export interface BiomeSnowOpts {
  res: number;
  mp: MacroParams;
  /** rgba16f normal+slope texture (filtered) */
  normalTex: StorageTexture;
  /** rgba16f fields texture: moisture, flowStrength, riverDepth, W */
  fieldsTex: StorageTexture;
}

export async function runBiomeSnow(
  renderer: Renderer,
  height: FloatBuffer,
  opts: BiomeSnowOpts,
): Promise<StorageTexture> {
  const { res, mp } = opts;
  const out = new StorageTexture(res, res);
  out.magFilter = NearestFilter;
  out.minFilter = NearestFilter;
  out.generateMipmaps = false;

  const kernel = Fn(() => {
    const i = instanceIndex;
    If(i.greaterThanEqual(res * res), () => {
      Return();
    });
    const x = i.mod(res);
    const y = i.div(res);
    const uv = vec2(float(x).add(0.5), float(y).add(0.5)).div(res);
    const wpos = uv.sub(0.5).mul(WORLD_SIZE);
    // design-space position: macro-correlated noise wavelengths are authored
    // for the ±2048 design space, so sample them at the zoomed position to keep
    // the miniature looking identical to the full-size world.
    const wposD = wpos.mul(MACRO_ZOOM);
    const h = height.element(i).toVar();
    const ns = texture(opts.normalTex, uv);
    const n = ns.xyz;
    const slope = ns.w;
    const fields = texture(opts.fieldsTex, uv);
    const moisture = fields.x;
    const water = fields.z;
    const zm = zoneMasksMini(wpos, mp);

    // temperature: lapse with altitude; north faces colder; noise breakup.
    // "north" is −z; aspect cooling scales with slope.
    const northness = n.z.negate().mul(clamp(slope, 0, 1)).clamp(0, 1);
    const tNoise = mx_noise_float(wposD.div(420).add(vec2(mp.off.hard[0], mp.off.hard[1])));
    // calibrated for the full world: onset ≈ 750 m, full ≈ ~1150 m (design m).
    // heights are scaled by WORLD_SCALE, so the lapse rate scales by MACRO_ZOOM
    // to keep the same snow band on the (now shorter) massif.
    const temp = float(11.8)
      .sub(h.mul(0.0125 * MACRO_ZOOM))
      .sub(northness.mul(2.0))
      .add(tNoise.mul(1.2));

    // local curvature from height buffer (ledge detection for snow/scree)
    const texel = WORLD_SIZE / res;
    const stepT = 3;
    const idx = (xx: typeof x, yy: typeof y) =>
      clamp(float(yy), 0, res - 1)
        .toInt()
        .mul(res)
        .add(clamp(float(xx), 0, res - 1).toInt());
    const hl = height.element(idx(x.sub(stepT), y));
    const hr = height.element(idx(x.add(stepT), y));
    const hd = height.element(idx(x, y.sub(stepT)));
    const hu = height.element(idx(x, y.add(stepT)));
    const lap = hl.add(hr).add(hd).add(hu).sub(h.mul(4)).div(stepT * stepT); // concave > 0
    // curvature (1/length) scales by MACRO_ZOOM under uniform shrink, so the
    // lap thresholds scale to match; slope is invariant → its thresholds stay.
    const ledge = smoothstep(0.08 * MACRO_ZOOM, 0.5 * MACRO_ZOOM, lap).mul(
      smoothstep(0.9, 0.35, slope),
    );

    // COARSE slope (16 m support): texel-scale crags make the 1 m slope ≥2.7
    // everywhere on the massif — snow holds on the landform, not the micro-relief
    const s8 = 14;
    const cl = height.element(idx(x.sub(s8), y));
    const cr = height.element(idx(x.add(s8), y));
    const cd = height.element(idx(x, y.sub(s8)));
    const cu = height.element(idx(x, y.add(s8)));
    const slopeCoarse = vec2(cr.sub(cl), cu.sub(cd)).length().div(2 * s8 * texel);
    // coarse concavity: couloirs/gullies between rock ribs accumulate snow —
    // this is what makes very steep massifs read snowy (white veins in crags)
    const lapCoarse = cl.add(cr).add(cd).add(cu).sub(h.mul(4)).div(s8 * s8 * texel);
    const couloir = smoothstep(0.015 * MACRO_ZOOM, 0.16 * MACRO_ZOOM, lapCoarse);

    // --- snow coverage ---------------------------------------------------------
    const snowTemp = smoothstep(2.6, -2.2, temp); // cold → 1
    const slopeHold = smoothstep(2.6, 0.8, slopeCoarse); // landform-scale cliffs shed
    const snow = clamp(
      snowTemp.mul(slopeHold).add(ledge.mul(snowTemp).mul(0.45)).add(couloir.mul(snowTemp).mul(0.9)),
      0,
      1,
    )
      .pow(0.78) // perceptual boost: partial coverage reads as snow, not gray
      .mul(smoothstep(0.02, 0.0, water)) // not on water
      .toVar();

    // --- rock exposure -----------------------------------------------------------
    const rockSlope = smoothstep(0.75, 1.45, slope);
    const rockExposure = clamp(
      rockSlope.add(zm.tKarst.mul(smoothstep(0.55, 1.0, slope)).mul(0.7)).add(zm.tAlp.mul(0.18)),
      0,
      1,
    );

    // --- biome decision tree -----------------------------------------------------
    const isAlpine = h.greaterThan(float(TREELINE).add(tNoise.mul(60 * WORLD_SCALE)));
    const isSubalpine = h.greaterThan(
      float(TREELINE - 170 * WORLD_SCALE).add(tNoise.mul(70 * WORLD_SCALE)),
    );
    const lowFlat = slope.lessThan(0.35);
    const isWetland = moisture
      .greaterThan(0.72)
      .and(lowFlat)
      .and(h.lessThan(LAKE_LEVEL + 70 * WORLD_SCALE));
    const meadowNoise = mx_noise_float(wposD.div(560).add(vec2(mp.off.hills[0], mp.off.hills[1])));
    const isMeadow = meadowNoise
      .greaterThan(0.22)
      .and(slope.lessThan(0.42))
      .and(moisture.lessThan(0.72))
      .and(h.lessThan(520 * WORLD_SCALE))
      .and(zm.tKarst.lessThan(0.4));
    const isKarst = zm.tKarst.greaterThan(0.42);

    const biome = isAlpine
      .select(
        float(Biome.Alpine),
        isSubalpine.select(
          float(Biome.Subalpine),
          isWetland.select(
            float(Biome.Wetland),
            isKarst.select(
              float(Biome.KarstForest),
              isMeadow.select(float(Biome.Meadow), float(Biome.Conifer)),
            ),
          ),
        ),
      )
      .toVar();

    // --- vegetation density --------------------------------------------------------
    const densBase = mix(float(0.85), float(0.25), rockExposure)
      .mul(smoothstep(-2.5, 1.5, temp))
      .mul(smoothstep(0.05, 0.25, moisture.add(0.15)))
      .mul(smoothstep(1.9, 1.1, slope));
    const dens = clamp(densBase.sub(snow.mul(0.7)), 0, 1);

    const DIAG_COMPONENTS = false; // temp bisect: write snow components
    textureStore(
      out,
      uvec2(x.toUint(), y.toUint()),
      DIAG_COMPONENTS
        ? vec4(snowTemp, slopeHold, ledge, temp.div(20).add(0.5))
        : vec4(biome.div(8), snow, dens, rockExposure),
    ).toWriteOnly();
  })().compute(res * res);
  kernel.setName('biomeSnowClassify');
  await renderer.computeAsync(kernel);
  return out;
}
