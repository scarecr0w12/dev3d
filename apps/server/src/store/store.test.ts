/**
 * Event-log retention.
 *
 * The `events` table is append-only and nothing ever removed from it, so a
 * long-lived office accumulated rows forever. The rows that dominated the growth
 * were the per-token `turn.delta` stream, which is no longer persisted at all;
 * this is the other half — the remaining rows are turn- and stage-level, which is
 * what an operator wants to keep, but "wants to keep" is not "unbounded".
 *
 * Both backends are tested, because they implement the same interface differently
 * and a fix applied to only one of them is the recurring failure this whole log
 * keeps recording.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openStore, type Store } from './store.ts';

const DAY = 24 * 60 * 60 * 1_000;

function silentLog(): { (level: 'debug' | 'info' | 'warn' | 'error', scope: string, message: string): void } {
  return () => {};
}

/** An event at a given age, so a cutoff can be expressed in whole days. */
function eventAt(ageMs: number, index: number): { runId: string; type: string; payloadJson: string; at: number } {
  return { runId: 'run_1', type: 'log', payloadJson: JSON.stringify({ index }), at: Date.now() - ageMs };
}

function exercise(store: Store): { removed: number; kept: number[] } {
  store.appendEvent(eventAt(40 * DAY, 0));
  store.appendEvent(eventAt(31 * DAY, 1));
  store.appendEvent(eventAt(10 * DAY, 2));
  store.appendEvent(eventAt(0, 3));
  // The cutoff is the same arithmetic the boot path uses: `retentionDays` back
  // from now, and everything strictly older goes.
  const removed = store.pruneEvents(Date.now() - 30 * DAY);
  const kept = store.recentEvents(10).map((entry) => (JSON.parse(entry.payloadJson) as { index: number }).index);
  return { removed, kept };
}

test('the persistent store prunes events past the retention window and only those', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dev3d-retention-'));
  const store = openStore(join(dir, 'dev3d.sqlite'), silentLog());
  try {
    assert.equal(store.persistent, true, store.backend);
    const { removed, kept } = exercise(store);
    assert.equal(removed, 2, 'only the two events older than the window should go');
    assert.deepEqual(kept, [2, 3], 'the recent events survive, in order');
    // A second prune inside the window is a no-op, not an error: retention runs
    // once per boot and must be safe to run again.
    assert.equal(store.pruneEvents(Date.now() - 30 * DAY), 0);
    assert.deepEqual(
      store.recentEvents(10).map((entry) => (JSON.parse(entry.payloadJson) as { index: number }).index),
      [2, 3],
    );
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the in-memory fallback prunes identically', () => {
  // A directory where the database file should be: opening it cannot succeed, so
  // this is the fallback backend, which has its own implementation of the same
  // interface.
  const dir = mkdtempSync(join(tmpdir(), 'dev3d-retention-mem-'));
  const unwritable = join(dir, 'not-a-file');
  mkdirSync(unwritable, { recursive: true });
  const store = openStore(unwritable, silentLog());
  try {
    assert.equal(store.persistent, false, store.backend);
    const { removed, kept } = exercise(store);
    assert.equal(removed, 2);
    assert.deepEqual(kept, [2, 3]);
    assert.equal(store.pruneEvents(Date.now() - 30 * DAY), 0);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a cutoff before every event prunes everything and reports it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dev3d-retention-all-'));
  const store = openStore(join(dir, 'dev3d.sqlite'), silentLog());
  try {
    for (let index = 0; index < 3; index += 1) store.appendEvent(eventAt(DAY, index));
    assert.equal(store.pruneEvents(Date.now()), 3, 'the count is what the boot log reports');
    assert.deepEqual(store.recentEvents(10), []);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
