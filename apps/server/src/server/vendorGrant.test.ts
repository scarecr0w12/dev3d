/**
 * Tests for `vendorsGrantedForRole`.
 *
 * This function decides whether an employee may launch a third-party process
 * against a project directory, so it is tested directly rather than inferred from
 * a working happy path - the same reason `mcpGrantedForRole` is tested the same
 * way. It is a pure function precisely so that this is possible.
 *
 * Two independent gates, and the interesting cases are all about one of them
 * being open while the other is shut.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { vendorsGrantedForRole, type VendorGrantConfig } from './runtime.ts';

function policy(overrides: Partial<VendorGrantConfig> = {}): VendorGrantConfig {
  return {
    enabled: true,
    configPath: null,
    grantRoles: ['delegate-roles'],
    requireCanDelegate: true,
    ...overrides,
  };
}

test('by default, delegating is for whoever may already delegate', () => {
  assert.equal(vendorsGrantedForRole({ id: 'cto', canDelegate: true }, policy()), true);
  assert.equal(vendorsGrantedForRole({ id: 'junior-dev', canDelegate: false }, policy()), false);
});

test('the org chart can take the ability away, whatever the policy says', () => {
  // `canDelegate` is the operator's own control on the org chart, and reading it
  // here is what finally gives that field an effect: before this feature it was
  // declared, populated for every role, and read by nothing at all.
  const wildcard = policy({ grantRoles: ['*'] });
  assert.equal(vendorsGrantedForRole({ id: 'junior-dev', canDelegate: false }, wildcard), false);
  assert.equal(vendorsGrantedForRole({ id: 'cto', canDelegate: true }, wildcard), true);
});

test('the policy can relax the canDelegate requirement, and then says so', () => {
  const relaxed = policy({ grantRoles: ['*'], requireCanDelegate: false });
  assert.equal(vendorsGrantedForRole({ id: 'junior-dev', canDelegate: false }, relaxed), true);
});

test('switching vendor delegation off closes the gate regardless', () => {
  const off = policy({ enabled: false, grantRoles: ['*'], requireCanDelegate: false });
  assert.equal(vendorsGrantedForRole({ id: 'cto', canDelegate: true }, off), false);
});

test('an empty grant list grants nobody', () => {
  // Default-deny, and the failure mode on the other side of this decision is an
  // unconfined third-party process in somebody's repository.
  const none = policy({ grantRoles: [] });
  assert.equal(vendorsGrantedForRole({ id: 'cto', canDelegate: true }, none), false);
});

test('naming roles grants exactly those roles, and nobody else', () => {
  const named = policy({ grantRoles: ['cto', 'dev-lead'] });
  assert.equal(vendorsGrantedForRole({ id: 'cto', canDelegate: true }, named), true);
  assert.equal(vendorsGrantedForRole({ id: 'dev-lead', canDelegate: true }, named), true);
  // A role with `canDelegate` but not named is still refused: the two gates are
  // independent, and both must open.
  assert.equal(vendorsGrantedForRole({ id: 'qa-lead', canDelegate: true }, named), false);
});

test('the delegate-roles marker is the canDelegate check, and grants nobody extra', () => {
  const marker = policy({ grantRoles: ['delegate-roles'], requireCanDelegate: true });
  // A role literally named "delegate-roles" must not be able to walk through the
  // marker by accident.
  assert.equal(vendorsGrantedForRole({ id: 'delegate-roles', canDelegate: false }, marker), false);
  assert.equal(vendorsGrantedForRole({ id: 'anything-else', canDelegate: true }, marker), true);
});

test('the marker plus requireCanDelegate=false would grant everyone, so it is not the default', () => {
  // Stated as a test because it is the one combination that silently opens the
  // gate wide, and it is reachable by setting two environment variables.
  const leaky = policy({ grantRoles: ['delegate-roles'], requireCanDelegate: false });
  assert.equal(vendorsGrantedForRole({ id: 'anyone', canDelegate: false }, leaky), true);
});
