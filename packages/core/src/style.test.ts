/**
 * Style tests.
 *
 * A style is a sparse patch over a preset, and the one thing that must hold is
 * that folding it is *total and pure*: the server and the browser both call
 * `resolveStyle`, so any disagreement between them is a floor that renders
 * differently from the form that saved it. The presets themselves are pinned
 * too - a preset that is missing a role leaves a surface undressed, which is
 * invisible in a type signature and obvious in a viewport.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_STYLE_PRESET,
  STYLE_PRESETS,
  STYLE_PRESET_ORDER,
  STYLE_ROLE_LABEL,
  STYLE_ROLE_ORDER,
  describeStyle,
  isStyleColor,
  parseOfficeStyle,
  resolveStyle,
  stylePreset,
  stylePatternLabel,
  type OfficeStyle,
  type StyleRole,
} from './style.ts';

const ROLES = Object.keys(STYLE_ROLE_LABEL) as StyleRole[];

test('every preset is complete, and its id matches its key', () => {
  const ids = Object.keys(STYLE_PRESETS);
  assert.ok(ids.length >= 6, `expected several presets to choose from, got ${ids.length}`);
  for (const id of ids) {
    const preset = STYLE_PRESETS[id];
    assert.equal(preset?.id, id, `${id}: the id field must match the key`);
    assert.ok(preset.name.length > 0, `${id}: needs a name`);
    assert.ok(preset.description.length > 0, `${id}: needs a description`);
    assert.equal(preset.swatch.length, 4, `${id}: the picker wants four swatches`);
    for (const colour of preset.swatch) {
      assert.ok(isStyleColor(colour), `${id}: swatch ${colour} is not a hex colour`);
    }
    // Every role, or a surface is left with nothing to draw.
    for (const role of ROLES) {
      const surface = preset.materials[role];
      assert.ok(surface, `${id}: no material for role "${role}"`);
      assert.ok(isStyleColor(surface.color), `${id}.${role}: "${surface.color}" is not a hex colour`);
      assert.ok(surface.roughness >= 0 && surface.roughness <= 1, `${id}.${role}: roughness out of range`);
      assert.ok(surface.metallic === undefined || (surface.metallic >= 0 && surface.metallic <= 1));
    }
    assert.ok(isStyleColor(preset.lighting.keyColor), `${id}: no key light colour`);
    assert.ok(preset.lighting.keyIntensity > 0, `${id}: a key light of zero is a black floor`);
    assert.ok(preset.lighting.exposure > 0, `${id}: exposure must be positive`);
    assert.ok(preset.environment.fogFar > preset.environment.fogNear, `${id}: fog must end after it starts`);
  }
});

test('the picker lists every preset, and the default is one of them', () => {
  assert.ok(STYLE_PRESET_ORDER.includes(DEFAULT_STYLE_PRESET));
  assert.deepEqual([...STYLE_PRESET_ORDER].sort(), Object.keys(STYLE_PRESETS).sort());
  assert.ok(STYLE_PRESET_ORDER.length === new Set(STYLE_PRESET_ORDER).size, 'no preset is listed twice');
});

test('the role order the editor lists covers every role exactly once', () => {
  assert.deepEqual([...STYLE_ROLE_ORDER].sort(), [...ROLES].sort());
  assert.equal(STYLE_ROLE_ORDER.length, new Set(STYLE_ROLE_ORDER).size);
});

test('an absent style resolves to the default preset, whole', () => {
  const resolved = resolveStyle(undefined);
  assert.equal(resolved.preset.id, DEFAULT_STYLE_PRESET);
  for (const role of ROLES) {
    assert.equal(resolved.materials[role].color, STYLE_PRESETS[DEFAULT_STYLE_PRESET]?.materials[role].color);
  }
});

test('a patch changes only the fields it names', () => {
  const style: OfficeStyle = {
    preset: 'noir',
    materials: { wall: { color: '#123456' } },
    lighting: { exposure: 1.5 },
  };
  const resolved = resolveStyle(style);
  const base = STYLE_PRESETS['noir'];

  assert.equal(resolved.materials.wall.color, '#123456');
  // The rest of the wall's surface comes from the preset, not from nothing.
  assert.equal(resolved.materials.wall.roughness, base?.materials.wall.roughness);
  assert.equal(resolved.materials.wall.pattern, base?.materials.wall.pattern);
  // Untouched roles are the preset's.
  assert.equal(resolved.materials.desk.color, base?.materials.desk.color);
  // Untouched lighting fields are the preset's; the named one is not.
  assert.equal(resolved.lighting.exposure, 1.5);
  assert.equal(resolved.lighting.keyIntensity, base?.lighting.keyIntensity);
  assert.equal(resolved.environment.background, base?.environment.background);
});

test('resolving is pure and total: the same style always gives the same values', () => {
  const style: OfficeStyle = { preset: 'neonlab', materials: { floor: { roughness: 0.1, pattern: 'hex' } } };
  const first = resolveStyle(style);
  const second = resolveStyle(style);
  assert.deepEqual(first, second);
  // And it does not mutate what it was given.
  assert.deepEqual(style.materials?.floor, { roughness: 0.1, pattern: 'hex' });
});

test('an unknown preset falls back rather than throwing', () => {
  assert.equal(stylePreset('does-not-exist').id, DEFAULT_STYLE_PRESET);
  assert.equal(stylePreset(undefined).id, DEFAULT_STYLE_PRESET);
  assert.equal(resolveStyle({ preset: 'nope' }).preset.id, DEFAULT_STYLE_PRESET);
});

test('an explicit undefined never erases a preset value', () => {
  // A form that submits an untouched optional field is the normal case, so an
  // absent field has to mean "leave it alone" even when it arrives as a key.
  const style = {
    preset: 'nordic',
    materials: { wall: { color: undefined, roughness: undefined } },
    lighting: { exposure: undefined },
  } as unknown as OfficeStyle;
  const resolved = resolveStyle(style);
  assert.equal(resolved.materials.wall.color, STYLE_PRESETS['nordic']?.materials.wall.color);
  assert.equal(resolved.lighting.exposure, STYLE_PRESETS['nordic']?.lighting.exposure);
});

test('parseOfficeStyle keeps what is usable and drops what is not', () => {
  const parsed = parseOfficeStyle({
    preset: 'industrial',
    materials: {
      wall: { color: '#AABBCC', roughness: 4, metallic: -2, pattern: 'planks', patternRepeat: 900 },
      glass: { color: 'rgb(1,2,3)' },
      notARole: { color: '#ffffff' },
      desk: {},
    },
    lighting: { keyIntensity: 2, exposure: 'bright', shadows: false, keyPosition: { x: 1, y: 2, z: 3 } },
    environment: { background: '#000000', fogNear: 'x' },
    nonsense: true,
  });
  assert.ok(parsed);
  assert.equal(parsed.preset, 'industrial');
  // Colours are normalised, numbers are clamped, and an unknown pattern is lost.
  assert.equal(parsed.materials?.wall?.color, '#aabbcc');
  assert.equal(parsed.materials?.wall?.roughness, 1, 'roughness is clamped into 0..1');
  assert.equal(parsed.materials?.wall?.metallic, 0, 'metallic is clamped into 0..1');
  assert.equal(parsed.materials?.wall?.pattern, 'planks');
  assert.equal(parsed.materials?.wall?.patternRepeat, 64, 'repeat is clamped to something tileable');
  // A bad colour loses the whole role rather than half of it.
  assert.equal(parsed.materials?.glass, undefined);
  assert.equal(parsed.materials?.notARole, undefined);
  assert.equal(parsed.materials?.desk, undefined, 'an empty patch is not worth storing');
  assert.equal(parsed.lighting?.keyIntensity, 2);
  assert.equal(parsed.lighting?.exposure, undefined, 'a non-number is dropped, not coerced');
  assert.equal(parsed.lighting?.shadows, false);
  assert.deepEqual(parsed.lighting?.keyPosition, { x: 1, y: 2, z: 3 });
  assert.equal(parsed.environment?.background, '#000000');
  assert.equal(parsed.environment?.fogNear, undefined);
});

test('parseOfficeStyle refuses anything that is not a style', () => {
  assert.equal(parseOfficeStyle(null), undefined);
  assert.equal(parseOfficeStyle('studio'), undefined);
  assert.equal(parseOfficeStyle([]), undefined);
  assert.equal(parseOfficeStyle(42), undefined);
  // An empty object is a valid style: it means "the default preset".
  assert.deepEqual(parseOfficeStyle({}), { preset: DEFAULT_STYLE_PRESET });
});

test('a parsed style round-trips through resolveStyle unchanged', () => {
  const original: OfficeStyle = {
    preset: 'atelier',
    materials: { accent: { color: '#ff8800' }, plant: { color: '#22aa55', roughness: 0.5 } },
    lighting: { ambientIntensity: 0.9, keyPosition: { x: -4, y: 9, z: 3 } },
    environment: { grid: false, fogFar: 60 },
  };
  const parsed = parseOfficeStyle(JSON.parse(JSON.stringify(original)));
  assert.deepEqual(resolveStyle(parsed), resolveStyle(original));
});

test('describeStyle says which preset and how much was changed', () => {
  assert.equal(describeStyle(undefined), `${STYLE_PRESETS[DEFAULT_STYLE_PRESET]?.name} (preset)`);
  assert.match(describeStyle({ preset: 'noir' }), /^Noir \(preset\)$/);
  const one = describeStyle({ preset: 'noir', materials: { wall: { color: '#111111' } } });
  assert.match(one, /^Noir · 1 adjustment$/);
  const several = describeStyle({
    preset: 'noir',
    materials: { wall: { color: '#111111' }, desk: { color: '#222222' } },
    lighting: { exposure: 2 },
  });
  assert.match(several, /^Noir · 3 adjustments$/);
});

test('isStyleColor accepts six-digit hex and nothing else', () => {
  assert.ok(isStyleColor('#a1b2c3'));
  assert.ok(isStyleColor('  #A1B2C3  '));
  assert.ok(!isStyleColor('#abc'), 'the renderers want six digits');
  assert.ok(!isStyleColor('red'));
  assert.ok(!isStyleColor('#a1b2c3d4'));
  assert.ok(!isStyleColor(16711680));
  assert.ok(!isStyleColor(null));
});

test('every pattern has a label, because the editor renders them all', () => {
  for (const pattern of ['plain', 'grid', 'planks', 'hex', 'weave', 'speckle'] as const) {
    assert.ok(stylePatternLabel(pattern).length > 0, `${pattern} has no label`);
  }
});
