/**
 * How a floor looks.
 *
 * The block kit decides the *shape* of a floor: where the rooms are, how big
 * they are, which walls have doorways. This module decides the other half — what
 * those rooms are made of. Two floors can grow the identical building and read
 * as a bright Scandinavian studio and a blacked-out server farm, and that is the
 * point: "custom" is a property of the finish, not only of the plan.
 *
 * Three decisions worth stating, because everything else follows from them:
 *
 *  - **A style is a sparse patch over a preset.** `{ preset: 'nordic' }` already
 *    means something complete, so a workspace that has never been styled renders
 *    as its preset's palette rather than as a hole in the scene. `resolveStyle`
 *    is the only thing that turns a patch into the full set of values, and it is
 *    pure, so the server and the browser agree by construction.
 *
 *  - **Roles, not material names.** Nothing here mentions `BM_Wall` or
 *    `M_Desk_Oak`. The kit and the core office were authored separately and share
 *    no material names, but they share *surfaces* — both have a wall, a desk, a
 *    screen. A style talks about roles, and each renderer maps its own materials
 *    onto them. That is what lets one style dress a hand-authored core room and a
 *    generated pod without either artifact knowing about the other.
 *
 *  - **Colour is authored in sRGB and used linearly.** A hex value is what a
 *    person picks and what a colour picker shows; renderers convert. Storing
 *    linear values would make every swatch in the UI wrong, and storing sRGB and
 *    forgetting to convert is the classic way to make a dark theme muddy.
 */

/** Every surface in the building a style can dress. */
export type StyleRole =
  /** The outer face of a room's walls. */
  | 'wall'
  /** A wall that carries the accent cut: trim, a feature wall, a corridor rail. */
  | 'accent'
  /** Partitions and meeting-room fronts. */
  | 'glass'
  /** The slab a floor's rooms sit on. */
  | 'floor'
  /** The softer floor *inside* a room, layered over the slab. */
  | 'carpet'
  /** Door frames, desk legs, chair posts, structural metal. */
  | 'frame'
  /** The raised floor finish a corridor or break area uses. */
  | 'trim'
  /** Desk and table tops. */
  | 'desk'
  /** Upholstery: sofas, chair pads, soft seating. */
  | 'soft'
  /** Foliage. */
  | 'plant'
  /** Area rugs. */
  | 'rug'
  /** Ceiling fixtures: pendants, strips, neon. */
  | 'light'
  /** Monitors and status LEDs — the only emissive surface in a room. */
  | 'screen'
  /** Cycle-friendly decorative strokes: a strong single hue. */
  | 'highlight';

/** The floor-finish patterns the renderer can draw. */
export type StylePattern = 'plain' | 'grid' | 'planks' | 'hex' | 'weave' | 'speckle';

/** How a role's surface behaves, independent of its colour. */
export interface StyleSurface {
  /** 0 = mirror-ish sheen, 1 = entirely diffuse. */
  roughness: number;
  /** 0 = matte, 1 = chrome-like. Absent means matte. */
  metallic?: number;
  /** Below 1 the surface is see-through, as a glass partition is. */
  opacity?: number;
  /** False for glass: keeping `transparent` off where it is not needed is free. */
  transparent?: boolean;
  /** Some surfaces read as a pattern rather than a flat fill. */
  pattern?: StylePattern;
  /** How many times the pattern tiles across a room module. */
  patternRepeat?: number;
}

/** A role's appearance: a colour, plus how it behaves. */
export interface StyleMaterial extends StyleSurface {
  /** `#rrggbb`, in sRGB. */
  color: string;
}

/**
 * The light rig.
 *
 * Kept to the four lights the scene actually has plus the ambient terms. A
 * style that wanted a sixth light would need a renderer change, so the honest
 * thing is to expose the knobs that exist rather than pretend to be a shader
 * graph.
 */
export interface StyleLighting {
  /** Directional key: the sun, and the only shadow caster. */
  keyColor: string;
  keyIntensity: number;
  keyPosition: { x: number; y: number; z: number };
  /** Warm bounce from the opposite side. */
  fillColor: string;
  fillIntensity: number;
  /** Cool rim, so the building separates from the background. */
  rimColor: string;
  rimIntensity: number;
  /** Sky/ground ambient: the room's baseline brightness and tint. */
  skyColor: string;
  groundColor: string;
  ambientIntensity: number;
  /** ACES tone-mapping exposure. */
  exposure: number;
  /**
   * Whether shadows are cast at all. Off is a legitimate style — a flat,
   * diagram-like look — and it is also the cheap option on weak hardware.
   */
  shadows: boolean;
}

/** The scene a floor is viewed in. */
export interface StyleEnvironment {
  /** Scene clear colour. */
  background: string;
  /** Fog colour; usually the background, and set separately so it need not be. */
  fogColor: string;
  fogNear: number;
  fogFar: number;
  /** Opacity of the shadow catcher under the building. */
  groundShadowOpacity: number;
  /** A faint grid on that catcher, to give the building a floor to stand on. */
  grid: boolean;
  gridColor: string;
}

/** A named look a workspace can start from. */
export interface StylePreset {
  id: string;
  /** Human name for the preset picker. */
  name: string;
  /** One line on what the look is for, shown under the name. */
  description: string;
  /** A few swatches for the picker's chip, in role order. */
  swatch: [string, string, string, string];
  materials: Record<StyleRole, StyleMaterial>;
  lighting: StyleLighting;
  environment: StyleEnvironment;
}

/**
 * One floor's look: a preset, plus whatever the user changed.
 *
 * Sparse on purpose. A stored patch says what is *different* from the preset, so
 * improving a preset improves every floor that used it and never touched that
 * field - which is what makes a preset worth having rather than a starting dump
 * of values.
 */
export interface OfficeStyle {
  preset: string;
  materials?: Partial<Record<StyleRole, Partial<StyleMaterial>>>;
  lighting?: Partial<StyleLighting>;
  environment?: Partial<StyleEnvironment>;
}

/** A preset's id. Free-form so a plugin can contribute one, but these ship. */
export type StylePresetId =
  | 'studio'
  | 'nordic'
  | 'industrial'
  | 'glasshouse'
  | 'neonlab'
  | 'noir'
  | 'paper'
  | 'atelier';

/** The role order the UI lists surfaces in: shell, then furniture, then light. */
export const STYLE_ROLE_ORDER: readonly StyleRole[] = [
  'wall',
  'accent',
  'glass',
  'floor',
  'carpet',
  'trim',
  'frame',
  'desk',
  'soft',
  'rug',
  'plant',
  'highlight',
  'light',
  'screen',
];

/** Human labels, so the editor and the presets cannot disagree on a word. */
export const STYLE_ROLE_LABEL: Record<StyleRole, string> = {
  wall: 'Walls',
  accent: 'Accent wall',
  glass: 'Glass',
  floor: 'Slab',
  carpet: 'Floor finish',
  trim: 'Raised trim',
  frame: 'Metalwork',
  desk: 'Desks & tables',
  soft: 'Upholstery',
  rug: 'Rugs',
  plant: 'Planting',
  highlight: 'Highlight',
  light: 'Light fixtures',
  screen: 'Screens',
};

/** Every pattern, in the order the editor offers them. */
export const STYLE_PATTERNS: readonly StylePattern[] = ['plain', 'grid', 'planks', 'hex', 'weave', 'speckle'];

const PATTERN_LABEL: Record<StylePattern, string> = {
  plain: 'Plain',
  grid: 'Tile grid',
  planks: 'Planks',
  hex: 'Hex tile',
  weave: 'Woven',
  speckle: 'Speckled',
};

export function stylePatternLabel(pattern: StylePattern): string {
  return PATTERN_LABEL[pattern];
}

function material(color: string, surface: StyleSurface = { roughness: 0.8, metallic: 0 }): StyleMaterial {
  return { color, ...surface };
}

/**
 * The eight looks that ship.
 *
 * They are deliberately far apart: a preset picker whose options all read as
 * "slightly different grey" is a worse tool than no picker at all. Every palette
 * is authored against the same role list, so switching preset never leaves a
 * surface undressed.
 */
export const STYLE_PRESETS: Record<string, StylePreset> = {
  studio: {
    id: 'studio',
    name: 'Studio',
    description: 'Cool concrete and pale walls — the neutral default.',
    swatch: ['#9a9ba1', '#383d47', '#15202c', '#3c4350'],
    materials: {
      wall: material('#9a9ba1', { roughness: 0.85, pattern: 'plain' }),
      accent: material('#383d47', { roughness: 0.8 }),
      glass: material('#8cb8cc', { roughness: 0.05, metallic: 0, opacity: 0.22, transparent: true }),
      floor: material('#26282c', { roughness: 0.75, pattern: 'grid', patternRepeat: 6 }),
      carpet: material('#1c2029', { roughness: 0.95, pattern: 'weave', patternRepeat: 8 }),
      trim: material('#2f333b', { roughness: 0.6 }),
      frame: material('#111214', { roughness: 0.35, metallic: 0.9 }),
      desk: material('#4f4236', { roughness: 0.5 }),
      soft: material('#3a4a63', { roughness: 0.9 }),
      rug: material('#282c37', { roughness: 1, pattern: 'speckle', patternRepeat: 3 }),
      plant: material('#2a6b3c', { roughness: 0.85 }),
      highlight: material('#f26a1b', { roughness: 0.45 }),
      light: material('#e8f1ff', { roughness: 0.3 }),
      screen: material('#0a0e14', { roughness: 0.25 }),
    },
    lighting: {
      keyColor: '#ffffff',
      keyIntensity: 1.35,
      keyPosition: { x: 10, y: 16, z: 8 },
      fillColor: '#ffd7a3',
      fillIntensity: 0.32,
      rimColor: '#7dd3fc',
      rimIntensity: 0.28,
      skyColor: '#9dc4ff',
      groundColor: '#14161d',
      ambientIntensity: 0.72,
      exposure: 1.04,
      shadows: true,
    },
    environment: {
      background: '#080a0f',
      fogColor: '#080a0f',
      fogNear: 30,
      fogFar: 78,
      groundShadowOpacity: 0.34,
      grid: true,
      gridColor: '#1b2030',
    },
  },

  nordic: {
    id: 'nordic',
    name: 'Nordic',
    description: 'Bright birch, paper-white walls, a low warm sun.',
    swatch: ['#e9e6df', '#cfc7b8', '#d8b183', '#7f9b8e'],
    materials: {
      wall: material('#e9e6df', { roughness: 0.9, pattern: 'plain' }),
      accent: material('#c6bfae', { roughness: 0.85 }),
      glass: material('#cfe6ea', { roughness: 0.04, opacity: 0.18, transparent: true }),
      floor: material('#b9ac97', { roughness: 0.7, pattern: 'planks', patternRepeat: 5 }),
      carpet: material('#d9d2c4', { roughness: 0.98, pattern: 'weave', patternRepeat: 9 }),
      trim: material('#cfc7b8', { roughness: 0.7 }),
      frame: material('#4a4a4a', { roughness: 0.4, metallic: 0.6 }),
      desk: material('#d8b183', { roughness: 0.55 }),
      soft: material('#7f9b8e', { roughness: 0.92 }),
      rug: material('#c3b7a4', { roughness: 1, pattern: 'speckle', patternRepeat: 3 }),
      plant: material('#5d8f56', { roughness: 0.85 }),
      highlight: material('#e0653f', { roughness: 0.5 }),
      light: material('#fff6e6', { roughness: 0.3 }),
      screen: material('#14181d', { roughness: 0.3 }),
    },
    lighting: {
      keyColor: '#fff4e2',
      keyIntensity: 1.75,
      keyPosition: { x: -8, y: 20, z: 11 },
      fillColor: '#ffe9cf',
      fillIntensity: 0.42,
      rimColor: '#cfe6ff',
      rimIntensity: 0.3,
      skyColor: '#dfeeff',
      groundColor: '#b6ab99',
      ambientIntensity: 1.05,
      exposure: 1.1,
      shadows: true,
    },
    environment: {
      background: '#e8eaee',
      fogColor: '#e8eaee',
      fogNear: 34,
      fogFar: 92,
      groundShadowOpacity: 0.2,
      grid: false,
      gridColor: '#c9cdd6',
    },
  },

  industrial: {
    id: 'industrial',
    name: 'Industrial',
    description: 'Raw steel, dark brick and caged lamps.',
    swatch: ['#8d7a6b', '#3b3a38', '#2b2b2b', '#a55a2a'],
    materials: {
      wall: material('#8d7a6b', { roughness: 0.95, pattern: 'grid', patternRepeat: 4 }),
      accent: material('#3b3a38', { roughness: 0.9 }),
      glass: material('#98a8ae', { roughness: 0.12, opacity: 0.28, transparent: true }),
      floor: material('#4c4a47', { roughness: 0.9, pattern: 'speckle', patternRepeat: 7 }),
      carpet: material('#3a3936', { roughness: 1, pattern: 'plain' }),
      trim: material('#5a5854', { roughness: 0.8 }),
      frame: material('#2b2b2b', { roughness: 0.45, metallic: 0.85 }),
      desk: material('#6d5741', { roughness: 0.65 }),
      soft: material('#5a5148', { roughness: 0.95 }),
      rug: material('#423b34', { roughness: 1, pattern: 'weave', patternRepeat: 3 }),
      plant: material('#4d6b3a', { roughness: 0.9 }),
      highlight: material('#a55a2a', { roughness: 0.6 }),
      light: material('#ffd9a0', { roughness: 0.35 }),
      screen: material('#0d1013', { roughness: 0.3 }),
    },
    lighting: {
      keyColor: '#fff0d6',
      keyIntensity: 1.15,
      keyPosition: { x: 12, y: 13, z: -6 },
      fillColor: '#ffb066',
      fillIntensity: 0.5,
      rimColor: '#6f8ea8',
      rimIntensity: 0.24,
      skyColor: '#6f7a86',
      groundColor: '#1b1a19',
      ambientIntensity: 0.5,
      exposure: 1.0,
      shadows: true,
    },
    environment: {
      background: '#0d0c0b',
      fogColor: '#141210',
      fogNear: 26,
      fogFar: 72,
      groundShadowOpacity: 0.45,
      grid: true,
      gridColor: '#241f1b',
    },
  },

  glasshouse: {
    id: 'glasshouse',
    name: 'Glasshouse',
    description: 'Daylight, pale timber and a lot of green.',
    swatch: ['#dfe7e2', '#b7d3bf', '#cbb894', '#4f8f63'],
    materials: {
      wall: material('#dfe7e2', { roughness: 0.8, pattern: 'plain' }),
      accent: material('#a9c4b3', { roughness: 0.8 }),
      glass: material('#dff0f2', { roughness: 0.03, opacity: 0.14, transparent: true }),
      floor: material('#9fa89b', { roughness: 0.75, pattern: 'grid', patternRepeat: 5 }),
      carpet: material('#c6d2c4', { roughness: 0.98, pattern: 'weave', patternRepeat: 8 }),
      trim: material('#b7c3b6', { roughness: 0.7 }),
      frame: material('#5c635c', { roughness: 0.4, metallic: 0.5 }),
      desk: material('#cbb894', { roughness: 0.55 }),
      soft: material('#8fb59a', { roughness: 0.92 }),
      rug: material('#b3bfae', { roughness: 1, pattern: 'speckle', patternRepeat: 3 }),
      plant: material('#4f8f63', { roughness: 0.8 }),
      highlight: material('#e9a13b', { roughness: 0.5 }),
      light: material('#ffffff', { roughness: 0.25 }),
      screen: material('#131a18', { roughness: 0.3 }),
    },
    lighting: {
      keyColor: '#ffffff',
      keyIntensity: 1.9,
      keyPosition: { x: 6, y: 22, z: 14 },
      fillColor: '#dff5e6',
      fillIntensity: 0.5,
      rimColor: '#d8f0ff',
      rimIntensity: 0.36,
      skyColor: '#e7f6ff',
      groundColor: '#9aa79b',
      ambientIntensity: 1.15,
      exposure: 1.08,
      shadows: true,
    },
    environment: {
      background: '#dde5e2',
      fogColor: '#dde5e2',
      fogNear: 36,
      fogFar: 96,
      groundShadowOpacity: 0.18,
      grid: false,
      gridColor: '#c3cdc8',
    },
  },

  neonlab: {
    id: 'neonlab',
    name: 'Neon lab',
    description: 'Dark shell, cyan key, magenta rim — late-night shipping.',
    swatch: ['#1b2030', '#22d3ee', '#f472b6', '#0a0e17'],
    materials: {
      wall: material('#1b2030', { roughness: 0.7, pattern: 'plain' }),
      accent: material('#252c40', { roughness: 0.6 }),
      glass: material('#22d3ee', { roughness: 0.05, opacity: 0.3, transparent: true }),
      floor: material('#0e1220', { roughness: 0.35, metallic: 0.35, pattern: 'hex', patternRepeat: 9 }),
      carpet: material('#141a2c', { roughness: 0.95, pattern: 'grid', patternRepeat: 10 }),
      trim: material('#26304a', { roughness: 0.5 }),
      frame: material('#0a0d15', { roughness: 0.25, metallic: 0.95 }),
      desk: material('#232a3d', { roughness: 0.4 }),
      soft: material('#3b2a55', { roughness: 0.85 }),
      rug: material('#1d1b3a', { roughness: 1, pattern: 'hex', patternRepeat: 4 }),
      plant: material('#2fbf8f', { roughness: 0.7 }),
      highlight: material('#f472b6', { roughness: 0.35 }),
      light: material('#22d3ee', { roughness: 0.2 }),
      screen: material('#050810', { roughness: 0.2 }),
    },
    lighting: {
      keyColor: '#bff3ff',
      keyIntensity: 1.05,
      keyPosition: { x: -9, y: 15, z: 9 },
      fillColor: '#22d3ee',
      fillIntensity: 0.65,
      rimColor: '#f472b6',
      rimIntensity: 0.6,
      skyColor: '#2b5c7a',
      groundColor: '#0a0c14',
      ambientIntensity: 0.55,
      exposure: 1.15,
      shadows: true,
    },
    environment: {
      background: '#05070d',
      fogColor: '#070a14',
      fogNear: 22,
      fogFar: 66,
      groundShadowOpacity: 0.5,
      grid: true,
      gridColor: '#16203a',
    },
  },

  noir: {
    id: 'noir',
    name: 'Noir',
    description: 'Blacked-out shell with a single hard key and deep shadows.',
    swatch: ['#2a2a2c', '#141416', '#0a0a0b', '#8f8f95'],
    materials: {
      wall: material('#2a2a2c', { roughness: 0.9, pattern: 'plain' }),
      accent: material('#141416', { roughness: 0.7 }),
      glass: material('#6f747c', { roughness: 0.06, opacity: 0.3, transparent: true }),
      floor: material('#111113', { roughness: 0.4, metallic: 0.2, pattern: 'planks', patternRepeat: 6 }),
      carpet: material('#17171a', { roughness: 1, pattern: 'plain' }),
      trim: material('#1d1d20', { roughness: 0.55 }),
      frame: material('#0a0a0b', { roughness: 0.3, metallic: 0.9 }),
      desk: material('#1f1d1b', { roughness: 0.5 }),
      soft: material('#25262b', { roughness: 0.9 }),
      rug: material('#1a1a1e', { roughness: 1, pattern: 'speckle', patternRepeat: 3 }),
      plant: material('#2c4a33', { roughness: 0.85 }),
      highlight: material('#b8b8bd', { roughness: 0.4, metallic: 0.5 }),
      light: material('#f4f6ff', { roughness: 0.2 }),
      screen: material('#040508', { roughness: 0.2 }),
    },
    lighting: {
      keyColor: '#ffffff',
      keyIntensity: 2.1,
      keyPosition: { x: 14, y: 18, z: 4 },
      fillColor: '#6b7280',
      fillIntensity: 0.16,
      rimColor: '#9ca3af',
      rimIntensity: 0.42,
      skyColor: '#4a5160',
      groundColor: '#08080a',
      ambientIntensity: 0.32,
      exposure: 0.98,
      shadows: true,
    },
    environment: {
      background: '#030304',
      fogColor: '#040405',
      fogNear: 20,
      fogFar: 62,
      groundShadowOpacity: 0.6,
      grid: false,
      gridColor: '#151518',
    },
  },

  paper: {
    id: 'paper',
    name: 'Paper',
    description: 'Flat, bright and diagram-like — for reading the plan, not the mood.',
    swatch: ['#ffffff', '#eceef2', '#d7dbe3', '#2f6df6'],
    materials: {
      wall: material('#ffffff', { roughness: 1, pattern: 'plain' }),
      accent: material('#eceef2', { roughness: 1 }),
      glass: material('#cfe0ff', { roughness: 0.1, opacity: 0.24, transparent: true }),
      floor: material('#f4f5f8', { roughness: 1, pattern: 'grid', patternRepeat: 8 }),
      carpet: material('#eceef2', { roughness: 1, pattern: 'grid', patternRepeat: 12 }),
      trim: material('#d7dbe3', { roughness: 1 }),
      frame: material('#9aa1ad', { roughness: 0.5, metallic: 0.2 }),
      desk: material('#dfe3ea', { roughness: 0.9 }),
      soft: material('#c3cede', { roughness: 1 }),
      rug: material('#e3e7ee', { roughness: 1, pattern: 'speckle', patternRepeat: 3 }),
      plant: material('#7cb98a', { roughness: 1 }),
      highlight: material('#2f6df6', { roughness: 0.8 }),
      light: material('#ffffff', { roughness: 0.5 }),
      screen: material('#28303c', { roughness: 0.6 }),
    },
    lighting: {
      keyColor: '#ffffff',
      keyIntensity: 1.6,
      keyPosition: { x: 8, y: 24, z: 10 },
      fillColor: '#ffffff',
      fillIntensity: 0.6,
      rimColor: '#dbe6ff',
      rimIntensity: 0.2,
      skyColor: '#ffffff',
      groundColor: '#cdd3dc',
      ambientIntensity: 1.35,
      exposure: 1.0,
      shadows: false,
    },
    environment: {
      background: '#fbfcfe',
      fogColor: '#fbfcfe',
      fogNear: 40,
      fogFar: 120,
      groundShadowOpacity: 0.1,
      grid: true,
      gridColor: '#dfe3ea',
    },
  },

  atelier: {
    id: 'atelier',
    name: 'Atelier',
    description: 'Terracotta and linen — a warm, workshop-ish studio.',
    swatch: ['#e4d4c3', '#b4674a', '#8c6f52', '#3f6b5e'],
    materials: {
      wall: material('#e4d4c3', { roughness: 0.92, pattern: 'speckle', patternRepeat: 5 }),
      accent: material('#b4674a', { roughness: 0.85 }),
      glass: material('#e2d9c8', { roughness: 0.08, opacity: 0.2, transparent: true }),
      floor: material('#8c6f52', { roughness: 0.7, pattern: 'planks', patternRepeat: 5 }),
      carpet: material('#d5c6b2', { roughness: 0.98, pattern: 'weave', patternRepeat: 8 }),
      trim: material('#c4ae94', { roughness: 0.75 }),
      frame: material('#3d3730', { roughness: 0.4, metallic: 0.7 }),
      desk: material('#a9835c', { roughness: 0.55 }),
      soft: material('#3f6b5e', { roughness: 0.9 }),
      rug: material('#c2a486', { roughness: 1, pattern: 'weave', patternRepeat: 4 }),
      plant: material('#5f7f4a', { roughness: 0.85 }),
      highlight: material('#d9822b', { roughness: 0.5 }),
      light: material('#ffe7c4', { roughness: 0.3 }),
      screen: material('#181513', { roughness: 0.3 }),
    },
    lighting: {
      keyColor: '#ffdcae',
      keyIntensity: 1.5,
      keyPosition: { x: -11, y: 14, z: 9 },
      fillColor: '#ffc98f',
      fillIntensity: 0.45,
      rimColor: '#9fd8c8',
      rimIntensity: 0.26,
      skyColor: '#ffd9a8',
      groundColor: '#4a3f33',
      ambientIntensity: 0.82,
      exposure: 1.06,
      shadows: true,
    },
    environment: {
      background: '#161210',
      fogColor: '#1c1613',
      fogNear: 28,
      fogFar: 80,
      groundShadowOpacity: 0.4,
      grid: false,
      gridColor: '#2a211b',
    },
  },
};

/** The presets in the order the picker shows them. */
export const STYLE_PRESET_ORDER: readonly string[] = [
  'studio',
  'nordic',
  'industrial',
  'glasshouse',
  'neonlab',
  'noir',
  'paper',
  'atelier',
];

/**
 * The preset a style should fall back to.
 *
 * `studio` is the palette the office shipped with before styles existed, so an
 * unstyled floor is byte-for-byte the view it always was. That is what makes
 * this feature additive rather than a redesign.
 */
export const DEFAULT_STYLE_PRESET = 'studio';

/** A preset by id, or the default. Never null, so callers need no fallback. */
export function stylePreset(id: string | undefined): StylePreset {
  const found = id === undefined ? undefined : STYLE_PRESETS[id];
  return found ?? (STYLE_PRESETS[DEFAULT_STYLE_PRESET] as StylePreset);
}

/** The complete, fully-defaulted appearance of a floor. */
export interface ResolvedStyle {
  preset: StylePreset;
  materials: Record<StyleRole, StyleMaterial>;
  lighting: StyleLighting;
  environment: StyleEnvironment;
}

/**
 * Fold a floor's sparse style over its preset.
 *
 * Pure, total, and the only place defaults are applied: given the same style it
 * returns the same values, in the server and in the browser, so a saved style can
 * never render differently from the form that saved it.
 */
export function resolveStyle(style: OfficeStyle | undefined): ResolvedStyle {
  const preset = stylePreset(style?.preset);
  const materials = {} as Record<StyleRole, StyleMaterial>;
  for (const role of Object.keys(preset.materials) as StyleRole[]) {
    const base = preset.materials[role];
    const patch = style?.materials?.[role];
    materials[role] = patch === undefined ? { ...base } : { ...base, ...defined(patch) };
  }
  return {
    preset,
    materials,
    lighting: { ...preset.lighting, ...defined(style?.lighting ?? {}) } as StyleLighting,
    environment: { ...preset.environment, ...defined(style?.environment ?? {}) } as StyleEnvironment,
  };
}

/**
 * Drop explicit `undefined`s from a patch.
 *
 * A spread of `{ color: undefined }` would *erase* the preset's colour, and a
 * form that submits an untouched optional field is the normal case, not an edge
 * case. So an absent field means "leave it alone", and this is what makes that
 * true for a patch that arrived over the wire.
 */
function defined<T extends object>(patch: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined && value !== null) out[key as keyof T] = value as T[keyof T];
  }
  return out;
}

/** What is different about this style, in words, for a console line. */
export function describeStyle(style: OfficeStyle | undefined): string {
  const preset = stylePreset(style?.preset);
  const changed = new Set<string>();
  for (const role of Object.keys(style?.materials ?? {}) as StyleRole[]) {
    if (style?.materials?.[role] !== undefined) changed.add(STYLE_ROLE_LABEL[role]);
  }
  for (const key of Object.keys(style?.lighting ?? {})) changed.add(`lighting.${key}`);
  for (const key of Object.keys(style?.environment ?? {})) changed.add(`scene.${key}`);
  if (changed.size === 0) return `${preset.name} (preset)`;
  return `${preset.name} · ${changed.size} adjustment${changed.size === 1 ? '' : 's'}`;
}

const HEX = /^#[0-9a-fA-F]{6}$/;

/** True for a colour this module is willing to hand to a renderer. */
export function isStyleColor(value: unknown): value is string {
  return typeof value === 'string' && HEX.test(value.trim());
}

/**
 * Coerce whatever arrived into a style that can be applied.
 *
 * Read as untrusted input for the same reason `parseBlockKit` is: a style
 * persisted by an older build, or hand-edited in the database, must degrade to
 * its preset rather than putting a `NaN` into a shader. Unknown fields are kept
 * only if they are a colour or a finite number, and an unknown preset falls back
 * to the default.
 */
export function parseOfficeStyle(raw: unknown): OfficeStyle | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const source = raw as Record<string, unknown>;
  const style: OfficeStyle = {
    preset: typeof source['preset'] === 'string' ? source['preset'] : DEFAULT_STYLE_PRESET,
  };

  const roles = source['materials'];
  if (typeof roles === 'object' && roles !== null && !Array.isArray(roles)) {
    const materials: Partial<Record<StyleRole, Partial<StyleMaterial>>> = {};
    for (const [role, value] of Object.entries(roles as Record<string, unknown>)) {
      if (!isStyleRole(role) || typeof value !== 'object' || value === null) continue;
      const patch = parseMaterialPatch(value as Record<string, unknown>);
      if (Object.keys(patch).length > 0) materials[role] = patch;
    }
    if (Object.keys(materials).length > 0) style.materials = materials;
  }

  const lighting = parseNumberPatch(source['lighting'], LIGHTING_KEYS, LIGHTING_COLORS);
  if (lighting) style.lighting = lighting as OfficeStyle['lighting'];
  const environment = parseNumberPatch(source['environment'], ENVIRONMENT_KEYS, ENVIRONMENT_COLORS);
  if (environment) style.environment = environment as OfficeStyle['environment'];
  return style;
}

function parseMaterialPatch(raw: Record<string, unknown>): Partial<StyleMaterial> {
  const patch: Partial<StyleMaterial> = {};
  if (isStyleColor(raw['color'])) patch.color = (raw['color'] as string).trim().toLowerCase();
  const roughness = finite(raw['roughness']);
  if (roughness !== undefined) patch.roughness = clamp01(roughness);
  const metallic = finite(raw['metallic']);
  if (metallic !== undefined) patch.metallic = clamp01(metallic);
  const opacity = finite(raw['opacity']);
  if (opacity !== undefined) patch.opacity = clamp01(opacity);
  if (typeof raw['transparent'] === 'boolean') patch.transparent = raw['transparent'];
  if (typeof raw['pattern'] === 'string' && (STYLE_PATTERNS as readonly string[]).includes(raw['pattern'])) {
    patch.pattern = raw['pattern'] as StylePattern;
  }
  const repeat = finite(raw['patternRepeat']);
  if (repeat !== undefined) patch.patternRepeat = Math.max(0.25, Math.min(64, repeat));
  return patch;
}

const LIGHTING_KEYS = [
  'keyIntensity',
  'fillIntensity',
  'rimIntensity',
  'ambientIntensity',
  'exposure',
] as const;
const LIGHTING_COLORS = ['keyColor', 'fillColor', 'rimColor', 'skyColor', 'groundColor'] as const;
const ENVIRONMENT_KEYS = ['fogNear', 'fogFar', 'groundShadowOpacity'] as const;
const ENVIRONMENT_COLORS = ['background', 'fogColor', 'gridColor'] as const;

function parseNumberPatch(
  raw: unknown,
  numbers: readonly string[],
  colors: readonly string[],
): Record<string, unknown> | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const source = raw as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of numbers) {
    const value = finite(source[key]);
    if (value !== undefined) out[key] = value;
  }
  for (const key of colors) {
    if (isStyleColor(source[key])) out[key] = (source[key] as string).trim().toLowerCase();
  }
  // The key vector arrives either as three numbers or as an object; both are
  // accepted so a form can post whichever is convenient.
  const position = source['keyPosition'];
  if (typeof position === 'object' && position !== null && !Array.isArray(position)) {
    const vector = position as Record<string, unknown>;
    const x = finite(vector['x']);
    const y = finite(vector['y']);
    const z = finite(vector['z']);
    if (x !== undefined && y !== undefined && z !== undefined) out['keyPosition'] = { x, y, z };
  }
  if (typeof source['shadows'] === 'boolean') out['shadows'] = source['shadows'];
  if (typeof source['grid'] === 'boolean') out['grid'] = source['grid'];
  return Object.keys(out).length > 0 ? out : null;
}

function isStyleRole(value: string): value is StyleRole {
  return Object.prototype.hasOwnProperty.call(STYLE_ROLE_LABEL, value);
}

function finite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}
