/**
 * Failure-path checks that a screenshot cannot make.
 *
 * Each of these asserts a promise the README makes about degradation: the office
 * keeps running when persistence is unavailable, a broken plugin is contained
 * rather than fatal, and a missing skills directory does not stop the boot.
 *
 *   node scripts/check-failure-paths.mjs
 */
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const { openStore } = await import('../apps/server/src/store/store.ts');
const { loadSkills } = await import('../apps/server/src/skills/loader.ts');

let failures = 0;
let checks = 0;

function check(name, condition, extra) {
  checks += 1;
  if (condition) {
    console.log(`  ok   ${name}`);
  } else {
    failures += 1;
    console.log(`  FAIL ${name}${extra === undefined ? '' : ` — ${extra}`}`);
  }
}

function silentLog() {
  const lines = [];
  const log = (level, scope, message) => lines.push(`${level} [${scope}] ${message}`);
  log.lines = lines;
  return log;
}

const tmp = mkdtempSync(join(tmpdir(), 'dev3d-failure-'));

try {
  console.log('failure paths');

  // ---------------------------------------------------------------- store
  {
    const log = silentLog();
    // A directory where the database file should be: opening it cannot succeed.
    const unwritable = join(tmp, 'not-a-file');
    mkdirSync(unwritable, { recursive: true });
    const store = openStore(unwritable, log);
    check('an unusable database path still yields a store', typeof store.backend === 'string');
    check('that store reports itself as non-persistent', store.persistent === false, store.backend);
    check('and says why', /memory/i.test(store.backend), store.backend);
    check('which is logged rather than swallowed', log.lines.length > 0, log.lines.join(' / '));
    // The document's real promise: the office boots and runs anyway.
    store.appendEvent({ runId: null, type: 'log', payload: { hello: true }, at: Date.now() });
    check('and it still accepts writes', store.recentEvents(10).length === 1);
    store.close();
  }
  {
    const log = silentLog();
    const file = join(tmp, 'real.sqlite');
    const store = openStore(file, log);
    check('a writable path is persistent', store.persistent === true, store.backend);
    store.close();
  }

  // --------------------------------------------------------------- skills
  {
    // A missing skills directory is a configuration mistake, not a reason to
    // refuse to start - the office runs with no skills pulled into context.
    let threw = null;
    let skills = null;
    try {
      skills = await loadSkills(join(tmp, 'no-such-skills'));
    } catch (error) {
      threw = error;
    }
    check('a missing skills directory does not throw', threw === null, threw?.message);
    check('and yields an empty catalogue', Array.isArray(skills) && skills.length === 0, String(skills?.length));
  }
  {
    // A skill file that cannot be parsed should name itself and be skipped,
    // rather than taking the whole catalogue down with it - one bad markdown
    // file in fifteen should cost you that skill, not the office.
    const dir = join(tmp, 'skills');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'good.md'), '---\nid: good\nname: Good\ndescription: fine\n---\n# Good\nbody\n');
    writeFileSync(join(dir, 'bad.md'), '---\nname: no id here\n---\n# Bad\nbody\n');
    let threw = null;
    let skills = null;
    try {
      skills = await loadSkills(dir);
    } catch (error) {
      threw = error;
    }
    check('one malformed skill does not stop the loader', threw === null, threw?.message);
    check('and the valid one still loads', skills?.some((s) => s.id === 'good') === true, String(skills?.length));
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) throw new Error(`${failures} failure-path check(s) failed`);
console.log('failure-path checks passed');
