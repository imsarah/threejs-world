/**
 * World constants — the single place defining world dimensions, grid sizes,
 * vertical scale, and biome identifiers. The macro layout (where the massif,
 * valley, karst zone, and lake live) is in MacroMap.ts.
 */

/**
 * Miniature world scale. The world was authored at 4096 m; everything is
 * uniformly scaled by WORLD_SCALE so it looks identical but is physically
 * smaller and boots faster. MACRO_ZOOM (=1/WORLD_SCALE) is how much to zoom
 * the macro-field sampling so the full ±2048 design composition is reproduced
 * across the shrunken world (see macroTerrainMini in MacroMap.ts).
 * To restore the full-size world, set WORLD_SCALE = 1.
 */
export const WORLD_SCALE = 0.25;
export const MACRO_ZOOM = 1 / WORLD_SCALE;

/** world edge length in meters; world spans [-WORLD_HALF, +WORLD_HALF]² */
export const WORLD_SIZE = 4096 * WORLD_SCALE;
export const WORLD_HALF = WORLD_SIZE / 2;
/** design-space half-width (the ±2048 coordinate space MacroMap is authored in) */
export const WORLD_HALF_DESIGN = 2048;

/** final composed heightfield resolution (~1 m/texel at the scaled world size) */
export const HEIGHT_RES = Math.round(4096 * WORLD_SCALE);
/** erosion / hydrology simulation grid (~2 m/texel) — was spec floor ≥2048 at full scale */
export const SIM_RES = Math.round(2048 * WORLD_SCALE);

/**
 * Vertical range: heights are meters above sea/datum 0.
 * The public constants are SCALED (compared against the final scaled height
 * texture by biome/material/scatter passes). The *_DESIGN variants are the
 * FULL authored values used INSIDE MacroMap's graph (whose height output is
 * scaled at the call boundary), so they must not be pre-scaled.
 */
export const LAKE_LEVEL_DESIGN = 142;
export const KARST_PLATEAU_DESIGN = 380;
export const LAKE_LEVEL = LAKE_LEVEL_DESIGN * WORLD_SCALE;
export const VALLEY_FLOOR = 165 * WORLD_SCALE;
export const KARST_PLATEAU = KARST_PLATEAU_DESIGN * WORLD_SCALE;
export const TREELINE = 950 * WORLD_SCALE;
export const SNOWLINE_BASE = 1050 * WORLD_SCALE;
export const SUMMIT_MAX = 1620 * WORLD_SCALE;

/** far-shell vista ring: analytic terrain from WORLD_HALF out to FAR_RADIUS */
export const FAR_RADIUS = 14000 * WORLD_SCALE;

/** biome ids (stored quantized in classification texture r-channel) */
export const enum Biome {
  Alpine = 0, // rock, scree, snow above treeline
  Subalpine = 1, // krummholz, sparse stunted conifers, heath
  Conifer = 2, // montane spruce/pine forest
  KarstForest = 3, // broadleaf forest among karst towers & ravines (refs 1–3)
  Meadow = 4, // grassland with flowers
  Wetland = 5, // lake margins, sedges, moisture-lovers
  COUNT = 6,
}

export const BIOME_NAMES: readonly string[] = [
  'alpine',
  'subalpine',
  'conifer',
  'karst-forest',
  'meadow',
  'wetland',
];

/** quality presets — smaller grids, never fewer systems */
export interface QualityConfig {
  heightRes: number;
  simRes: number;
  erosionIters: number;
  tileVerts: number; // vertices per tile edge
}

export function qualityConfig(preset: 'low' | 'high' | 'ultra'): QualityConfig {
  // heightRes/simRes scale with the world; erosionIters/tileVerts do not.
  switch (preset) {
    case 'low':
      return {
        heightRes: Math.round(2048 * WORLD_SCALE),
        simRes: Math.round(1024 * WORLD_SCALE),
        erosionIters: 500,
        tileVerts: 49,
      };
    case 'ultra':
      return {
        heightRes: Math.round(4096 * WORLD_SCALE),
        simRes: Math.round(2048 * WORLD_SCALE),
        erosionIters: 900,
        tileVerts: 81,
      };
    case 'high':
      return { heightRes: HEIGHT_RES, simRes: SIM_RES, erosionIters: 640, tileVerts: 65 };
  }
}
