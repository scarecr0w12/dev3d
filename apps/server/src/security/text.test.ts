/**
 * Tests for making text from elsewhere safe to read.
 *
 * Two callers, one problem: harness output (a third-party agent that colourises
 * its stdout) and tool output — which is attacker-influenced *by design*, since
 * `read_file` can be pointed at a hostile README, `git show` at a hostile commit
 * message, and `web_fetch` at any page on the internet. Both land in a prompt.
 *
 * The interesting half is not the colour codes. It is the characters that make
 * text *display* as something other than what it says — a bidi override, a
 * zero-width joiner — which deceive the reader rather than merely clutter.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  UNTRUSTED_CLOSE,
  UNTRUSTED_OPEN,
  fenceUntrusted,
  stripControlSequences,
} from './text.ts';

test('terminal colour and cursor sequences are removed', () => {
  assert.equal(stripControlSequences('\u001b[31mred\u001b[0m'), 'red');
  assert.equal(stripControlSequences('a\u001b[1;32mb\u001b[0mc'), 'abc');
  // Cursor movement and screen clearing.
  assert.equal(stripControlSequences('\u001b[2J\u001b[Hclean'), 'clean');
  // A lone ESC, and other two-character escapes.
  assert.equal(stripControlSequences('a\u001bMb'), 'ab');
  assert.equal(stripControlSequences('a\u001bb'), 'ab');
});

test('OSC sequences are removed, including the clipboard one', () => {
  // OSC-52 writes the clipboard. A transcript copied out of the console must not
  // carry one, and a model has no business reading one.
  assert.equal(stripControlSequences('\u001b]52;c;aGVsbG8=\u0007after'), 'after');
  assert.equal(stripControlSequences('\u001b]52;c;aGVsbG8=\u001b\\after'), 'after');
  // OSC-8 makes clickable hyperlinks; the zero-width terminator around the label
  // goes too.
  assert.equal(stripControlSequences('\u001b]8;;https://e.test\u0007label\u001b]8;;\u0007'), 'label');
});

test('bidi overrides and zero-width characters are removed', () => {
  // These are the deception case: the text displays as something other than what
  // it says, which is aimed at whoever is reading it — a person checking a
  // transcript, or a model judging whether a file looks safe.
  assert.equal(stripControlSequences('a\u202eb'), 'ab');
  assert.equal(stripControlSequences('safe\u202egnp.exe'), 'safegnp.exe');
  assert.equal(stripControlSequences('a\u200bb'), 'ab');
  assert.equal(stripControlSequences('a\ufeffb'), 'ab');
  assert.equal(stripControlSequences('\u2066 isolate \u2069'), ' isolate ');
});

test('C0 and C1 controls go, but newlines and tabs stay', () => {
  assert.equal(stripControlSequences('a\u0000\u0007\u001fb'), 'ab');
  assert.equal(stripControlSequences('a\u007fb'), 'ab');
  assert.equal(stripControlSequences('a\u0085b'), 'ab');
  // Newlines and tabs carry meaning in prose and code, and everything downstream
  // parses lines.
  assert.equal(stripControlSequences('one\ntwo\tthree'), 'one\ntwo\tthree');
  assert.equal(stripControlSequences('a\r\nb'), 'a\r\nb', 'CRLF survives: it is a line ending, not a control code to hide');
});

test('ordinary text is untouched', () => {
  const prose = '### Real question\n\nName the file, line and version.\n\n- one\n- two';
  assert.equal(stripControlSequences(prose), prose);
});

test('untrusted text is fenced and labelled with where it came from', () => {
  const fenced = fenceUntrusted('hello', 'tool:read_file');
  assert.ok(fenced.startsWith(`${UNTRUSTED_OPEN}tool:read_file>`), fenced);
  assert.ok(fenced.endsWith(UNTRUSTED_CLOSE), fenced);
  assert.ok(fenced.includes('hello'));
});

test('the fence strips before it wraps, so nothing hides inside it', () => {
  const fenced = fenceUntrusted('a\u202eb\u001b[31mc', 'tool:web_fetch');
  assert.ok(!fenced.includes('\u202e'), 'the bidi override must not survive the fence');
  assert.ok(!fenced.includes('\u001b'), 'nor the escape');
  assert.ok(fenced.includes('abc'));
});

test('a hostile source label cannot break out of its own attribute', () => {
  // The label is built from a tool name, which is ours — but the function is
  // exported, so the guard is worth having rather than relying on that.
  const fenced = fenceUntrusted('x', 'evil"><script>');
  assert.equal(fenced.split('\n')[0], `${UNTRUSTED_OPEN}evilscript>`);
});
