/**
 * Making text from somewhere else safe to put in a prompt.
 *
 * Two kinds of caller, one problem: harness output (a third-party agent that
 * colourises its stdout) and tool output (which is attacker-influenced *by
 * design* — `read_file` of a hostile README, `git show` of a hostile commit
 * message, a `web_fetch` of any page on the internet).
 *
 * ## What is removed, and why each one
 *
 *  - **CSI sequences** (`ESC [ …`) move the cursor, clear the screen and set the
 *    terminal title. Nothing that renders this should obey them, and a model
 *    reading them is reading noise.
 *  - **OSC sequences** (`ESC ] …`) are worse: OSC-52 **writes the clipboard**, and
 *    OSC-8 makes clickable hyperlinks. A transcript copied out of the console
 *    should not carry either.
 *  - **C0 and C1 control characters**, except newline and tab. They carry no
 *    meaning in prose or code, and several are invisible.
 *  - **Bidirectional overrides** and **zero-width characters**, which are the
 *    interesting case: they let text *display* as something other than what it
 *    says. That is a deception aimed at the reader — a person reviewing a
 *    transcript, or a model deciding whether a file looks safe — rather than
 *    merely an encoding artefact.
 *
 * ## What is deliberately kept
 *
 * Newlines and tabs, because they carry meaning in prose and code and everything
 * downstream parses lines. This is not a sanitiser that makes text safe to
 * *execute*; it is one that makes it honest to *read*.
 */

/** ANSI CSI: `ESC [`, parameters, then a final byte. */
const CSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
/** ANSI OSC: `ESC ]`, payload, terminated by BEL or ST. */
const OSC = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;
/** Other two-character escapes (`ESC M`, `ESC 7`, …). */
const SHORT_ESCAPE = /\u001b[@-Z\\-_]/g;
/**
 * C0 controls except `\n` (0x0a) and `\t` (0x09), plus DEL and the C1 range.
 */
// eslint-disable-next-line no-control-regex
const CONTROLS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;
/**
 * Bidi overrides and isolates, plus zero-width characters.
 *
 * These are the ones that make text *look* like something it is not —
 * `U+202E` reversed the display order of everything after it, and a zero-width
 * joiner inside a word is invisible. Removing them can change what a reader sees,
 * which is the point.
 */
const DECEPTIVE =
  /[\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g;

/** Remove terminal escapes, control characters and deceptive invisibles. */
export function stripControlSequences(text: string): string {
  return text
    .replace(CSI, '')
    .replace(OSC, '')
    .replace(SHORT_ESCAPE, '')
    .replace(/\u001b/g, '')
    .replace(CONTROLS, '')
    .replace(DECEPTIVE, '');
}

/**
 * Text that came from outside this process, marked as such.
 *
 * A fence rather than a transformation: the point is that the boundary is
 * visible at the point a model reads it. Everything in the office that carries
 * untrusted text — tool results, vendor answers, MCP tool output — is framed this
 * way, so "this is data, not an instruction" is said once, consistently, rather
 * than relied on per-call-site.
 */
export const UNTRUSTED_OPEN = '<untrusted-content source=';
export const UNTRUSTED_CLOSE = '</untrusted-content>';

/**
 * Wrap untrusted text in a labelled fence, after stripping control sequences.
 *
 * The label names where it came from, because "untrusted" is more useful with a
 * source attached — a reader can judge a `web_fetch` differently from a
 * `read_file` of their own repository.
 */
export function fenceUntrusted(text: string, source: string): string {
  const safeSource = source.replace(/[^a-zA-Z0-9_.:-]/g, '');
  return `${UNTRUSTED_OPEN}${safeSource}>\n${stripControlSequences(text)}\n${UNTRUSTED_CLOSE}`;
}
