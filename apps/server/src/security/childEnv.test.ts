/**
 * Tests for the child-process environment filter.
 *
 * The property under test: a process the office spawns must not be able to read
 * the office's provider credentials out of its own environment. `config.ts`
 * loads `.env` into `process.env`, so before this filter existed a one-line
 * `run_shell` command, a third-party vendor harness, and a downloaded MCP server
 * all inherited every API key — with no approval prompt that mentioned it.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  childEnv,
  isSecretEnvName,
  registerSecretEnvName,
  resetRegisteredSecretEnvNames,
  secretEnvNames,
} from './childEnv.ts';

test('a conventionally-named credential is withheld from children', () => {
  process.env['DEV3D_TEST_FAKE_API_KEY'] = 'sk-secret-value';
  process.env['DEV3D_TEST_SAFE_VALUE'] = 'harmless';
  try {
    const env = childEnv();
    assert.equal(env['DEV3D_TEST_FAKE_API_KEY'], undefined, 'the key must not reach the child');
    assert.equal(env['DEV3D_TEST_SAFE_VALUE'], 'harmless', 'ordinary variables still pass');
    assert.equal(process.env['DEV3D_TEST_FAKE_API_KEY'], 'sk-secret-value', 'the parent is untouched');
  } finally {
    delete process.env['DEV3D_TEST_FAKE_API_KEY'];
    delete process.env['DEV3D_TEST_SAFE_VALUE'];
  }
});

test('an explicitly registered name is withheld even without a conventional suffix', () => {
  resetRegisteredSecretEnvNames();
  process.env['DEV3D_TEST_ODDLY_NAMED_CRED'] = 'value';
  try {
    assert.equal(childEnv()['DEV3D_TEST_ODDLY_NAMED_CRED'], 'value', 'not secret until declared');
    registerSecretEnvName('DEV3D_TEST_ODDLY_NAMED_CRED');
    assert.equal(childEnv()['DEV3D_TEST_ODDLY_NAMED_CRED'], undefined, 'withheld once declared');
    assert.ok(secretEnvNames().includes('DEV3D_TEST_ODDLY_NAMED_CRED'));
  } finally {
    delete process.env['DEV3D_TEST_ODDLY_NAMED_CRED'];
    resetRegisteredSecretEnvNames();
  }
});

test('the shipping provider keys are recognised as secrets', () => {
  for (const name of [
    'DEEPSEEK_API_KEY',
    'OPENAI_API_KEY',
    'OPENROUTER_API_KEY',
    'ANTHROPIC_API_KEY',
    'DEV3D_LOCAL_API_KEY',
    'ARTIFICIAL_ANALYSIS_API_KEY',
  ]) {
    assert.equal(isSecretEnvName(name), true, `${name} must be treated as a credential`);
  }
  // …and the filter is not so broad that it starves a build.
  for (const name of ['PATH', 'HOME', 'TMPDIR', 'SystemRoot', 'NODE_ENV', 'SSH_AUTH_SOCK']) {
    assert.equal(isSecretEnvName(name), false, `${name} must still reach the child`);
  }
});

test('credential-named and value-bearing variables are withheld; bare indirections are not', () => {
  // The line this file draws. A name that says credential is withheld whatever it
  // holds — `GOOGLE_APPLICATION_CREDENTIALS` is a path and `AZURE_CREDENTIALS` is a
  // JSON blob, and a rule that tried to tell those apart would be one that fails open.
  // What stays are indirections with their own names and no credential suffix.
  const withheld = [
    'AWS_ACCESS_KEY_ID',
    'AWS_SECRET_ACCESS_KEY',
    'AWS_SESSION_TOKEN',
    'GH_TOKEN',
    'GITHUB_TOKEN',
    'NPM_TOKEN',
    'CI_JOB_TOKEN',
    'PGPASSWORD',
    'MYSQL_PWD',
    'GOOGLE_APPLICATION_CREDENTIALS',
    'MY_SERVICE_TOKEN',
    'SOME_ACCESS_KEY',
    'A_PRIVATE_KEY',
    'A_CREDENTIALS',
    'A_PASSWD',
    'A_PASS',
  ];
  for (const name of withheld) {
    assert.equal(isSecretEnvName(name), true, `${name} must be withheld`);
  }

  // Indirections and ordinary toolchain variables stay, so a build keeps working.
  for (const name of ['KUBECONFIG', 'SSH_AUTH_SOCK', 'SSH_KEY_PATH', 'GPG_KEY', 'JAVA_HOME', 'GOPATH', 'CARGO_HOME', 'PASSWORD_STORE_DIR']) {
    assert.equal(isSecretEnvName(name), false, `${name} must still reach the child`);
  }
});

test('the AWS credential pair is actually removed from a child environment', () => {
  // The pair that motivated the rule: it matches no separator-suffix precedent —
  // `AWS_SECRET_ACCESS_KEY` ends in the word KEY rather than `_KEY` — so it was
  // reaching every child the office spawned, including a downloaded MCP server.
  process.env['AWS_ACCESS_KEY_ID'] = 'AKIAEXAMPLE';
  process.env['AWS_SECRET_ACCESS_KEY'] = 'secret';
  process.env['AWS_SESSION_TOKEN'] = 'session';
  try {
    const env = childEnv();
    assert.equal(env['AWS_ACCESS_KEY_ID'], undefined);
    assert.equal(env['AWS_SECRET_ACCESS_KEY'], undefined);
    assert.equal(env['AWS_SESSION_TOKEN'], undefined);
    assert.equal(process.env['AWS_SECRET_ACCESS_KEY'], 'secret', 'the parent keeps its own environment');
  } finally {
    delete process.env['AWS_ACCESS_KEY_ID'];
    delete process.env['AWS_SECRET_ACCESS_KEY'];
    delete process.env['AWS_SESSION_TOKEN'];
  }
});

test('caller-supplied extra variables are merged, and a credential cannot be resurrected', () => {
  process.env['DEV3D_TEST_LEAK_API_KEY'] = 'sk-leak';
  try {
    const env = childEnv({
      DEV3D_TEST_EXTRA: 'given',
      // Passing a withheld credential through `extra` must not work: `extra` is
      // for vendor- and server-specific settings, not a way around the filter.
      DEV3D_TEST_LEAK_API_KEY: process.env['DEV3D_TEST_LEAK_API_KEY'],
    });
    assert.equal(env['DEV3D_TEST_EXTRA'], 'given');
    assert.equal(env['DEV3D_TEST_LEAK_API_KEY'], undefined);
  } finally {
    delete process.env['DEV3D_TEST_LEAK_API_KEY'];
  }
});

test('childEnv returns a copy, so a caller cannot mutate the parent environment', () => {
  const env = childEnv();
  env['DEV3D_TEST_MUTATION'] = 'x';
  assert.equal(process.env['DEV3D_TEST_MUTATION'], undefined);
});
