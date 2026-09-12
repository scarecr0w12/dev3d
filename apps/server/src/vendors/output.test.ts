/**
 * Tests for reading a vendor's answer out of its output.
 *
 * The theme of every assertion here is **degrade, never lose the answer**. A
 * harness that changes its event shape, prints a banner on line one, or emits a
 * version of the protocol nobody has seen must still yield its prose - an
 * integration that answers "I could not parse this" when the text is sitting
 * right there in the output is worse than one that returns something untidy.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { extractVendorAnswer } from './output.ts';

test('a plain-text vendor gets its stdout back, trimmed', () => {
  const answer = extractVendorAnswer('\n  the session lookup is fine  \n\n', 'text');
  assert.equal(answer.text, 'the session lookup is fine');
  assert.equal(answer.parsed, false);
  assert.equal(answer.reportedStatus, null);
  assert.deepEqual(answer.files, []);
});

test('an empty output is an empty answer, not an error', () => {
  const answer = extractVendorAnswer('', 'codex-jsonl');
  assert.equal(answer.text, '');
  assert.equal(answer.parsed, false);
});

/**
 * The documented `--json` shape: a stream of `{method, params}` lines, where the
 * assistant's text is one `item/completed` among dozens of events.
 */
function jsonl(lines: unknown[]): string {
  return lines.map((line) => JSON.stringify(line)).join('\n');
}

test('the answer is pulled out of the event stream, not the raw JSONL', () => {
  const raw = jsonl([
    { method: 'turn/started', params: { turn: { id: 'turn_1', status: 'inProgress' } } },
    { method: 'item/started', params: { item: { type: 'agentMessage', id: 'msg_1' } } },
    { method: 'item/agentMessage/delta', params: { itemId: 'msg_1', delta: 'Running' } },
    {
      method: 'item/completed',
      params: { item: { type: 'agentMessage', id: 'msg_1', text: 'The lookup derefs null at session.ts:41.' } },
    },
    { method: 'turn/completed', params: { turn: { id: 'turn_1', status: 'completed' } } },
  ]);

  const answer = extractVendorAnswer(raw, 'codex-jsonl');
  assert.equal(answer.text, 'The lookup derefs null at session.ts:41.');
  assert.equal(answer.parsed, true);
  assert.equal(answer.reportedStatus, 'completed');
  // The point of parsing at all: the model is handed the answer, not a wall of
  // JSON it would have to be told to ignore.
  assert.doesNotMatch(answer.text, /turn\/started/);
});

test('several completed messages are joined in order', () => {
  const raw = jsonl([
    { method: 'item/completed', params: { item: { type: 'agentMessage', id: 'a', text: 'First.' } } },
    { method: 'item/completed', params: { item: { type: 'agentMessage', id: 'b', text: 'Second.' } } },
  ]);
  assert.equal(extractVendorAnswer(raw, 'codex-jsonl').text, 'First.\n\nSecond.');
});

test('a delta stream is the answer when no message was ever completed', () => {
  // What a run that was cut off produces: chunks but no completed item. The
  // partial text is still the most useful thing the office has.
  const raw = jsonl([
    { method: 'item/agentMessage/delta', params: { itemId: 'm', delta: 'half an ' } },
    { method: 'item/agentMessage/delta', params: { itemId: 'm', delta: 'answer' } },
  ]);
  const answer = extractVendorAnswer(raw, 'codex-jsonl');
  assert.equal(answer.text, 'half an answer');
  assert.equal(answer.parsed, true);
});

test('a banner on line one does not cost the answer on line two', () => {
  const raw = `Welcome to codex v1.2.3\n${jsonl([
    { method: 'item/completed', params: { item: { type: 'agentMessage', id: 'm', text: 'Still found it.' } } },
  ])}`;
  const answer = extractVendorAnswer(raw, 'codex-jsonl');
  assert.equal(answer.text, 'Still found it.');
  assert.equal(answer.parsed, true);
});

test('a stream that parses but carries no message falls back to the raw output', () => {
  // Returning nothing here would report a working run as an empty answer, which
  // is the one outcome the extractor exists to avoid.
  const raw = jsonl([{ method: 'turn/completed', params: { turn: { id: 't', status: 'completed' } } }]);
  const answer = extractVendorAnswer(raw, 'codex-jsonl');
  assert.equal(answer.parsed, false);
  assert.equal(answer.text, raw.trim());
  assert.equal(answer.reportedStatus, 'completed');
});

test('prose that merely starts with a brace is not treated as an event stream', () => {
  const raw = '{ "this is": "just json the model wrote" }\n\nand then a sentence.';
  const answer = extractVendorAnswer(raw, 'codex-jsonl');
  assert.equal(answer.text, raw.trim());
  assert.equal(answer.parsed, false);
});

test('a malformed line is skipped rather than fatal', () => {
  const raw = ['{ not json at all', '{"method":"item/completed","params":{"item":{"type":"agentMessage","text":"ok"}}}'].join('\n');
  assert.equal(extractVendorAnswer(raw, 'codex-jsonl').text, 'ok');
});

test('file paths are collected from a nested tool item', () => {
  const raw = jsonl([
    {
      method: 'item/completed',
      params: {
        item: {
          type: 'fileChange',
          changes: [{ path: 'src/auth/session.ts' }, { path: 'src/auth/session.test.ts' }],
        },
      },
    },
    { method: 'item/completed', params: { item: { type: 'agentMessage', id: 'm', text: 'Two files.' } } },
  ]);
  const answer = extractVendorAnswer(raw, 'codex-jsonl');
  assert.deepEqual(answer.files, ['src/auth/session.test.ts', 'src/auth/session.ts']);
});

test('a URL is never mistaken for a file the vendor touched', () => {
  // A false positive here puts a path in `turn.wroteFiles` that nobody wrote,
  // which is what decides who a review loop sends work back to.
  const raw = jsonl([
    { method: 'item/completed', params: { item: { type: 'tool', url: 'https://example.test/a/b.ts' } } },
  ]);
  assert.deepEqual(extractVendorAnswer(raw, 'codex-jsonl').files, []);
});

test('a bare word with no separator and no extension is not a path', () => {
  const raw = jsonl([{ method: 'item/completed', params: { item: { type: 'tool', path: 'session' } } }]);
  assert.deepEqual(extractVendorAnswer(raw, 'codex-jsonl').files, []);
});
