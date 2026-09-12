/**
 * Reading a vendor's answer out of whatever it printed.
 *
 * Three harnesses, two shapes. DeepSeek Harness in headless mode and Hermes both
 * print the final assistant text on stdout and nothing else - the contract is
 * explicit about that for DSH ("last non-empty assistant text from the owned run
 * interval"). Codex with `--json` prints a JSONL event stream instead, where the
 * answer is one event among dozens.
 *
 * The whole module is written to **degrade rather than fail**. A vendor that
 * changes its event shape, prints a banner, or emits a version we have never
 * seen must still yield its prose: an integration that returns "I could not
 * parse this" when the answer is sitting right there in the output is worse than
 * one that returns slightly untidy text. So every extractor ends in a fallback to
 * the raw stream.
 */

export type VendorOutputFormat = 'text' | 'codex-jsonl';

export interface VendorAnswer {
  /** The vendor's answer, trimmed. Empty when it produced nothing. */
  text: string;
  /**
   * True when the answer came from a structured event rather than the raw
   * stream. The console uses it to say "parsed" honestly rather than implying
   * every vendor reports the same way.
   */
  parsed: boolean;
  /** The vendor's own terminal status, when it reported one. */
  reportedStatus: string | null;
  /**
   * Workspace-relative paths the vendor says it touched.
   *
   * Best-effort by construction. A read-only delegation writes nothing, so an
   * empty list is the *expected* answer here - this exists so that enabling
   * writes later does not silently leave `turn.wroteFiles` blind to what an
   * external agent did (see `docs/external-agents.md` §5.6).
   */
  files: string[];
}

/** Keys whose string value is plausibly a path the vendor touched. */
const PATH_KEYS = ['path', 'file', 'filePath', 'filepath', 'filename', 'target'];

/**
 * Turn raw stdout into an answer.
 *
 * `fallbackOnEmpty` matters for `codex-jsonl`: a stream that parses cleanly but
 * yields no agent message is not the same as an empty answer, so the raw text is
 * used instead of returning nothing.
 */
export function extractVendorAnswer(raw: string, format: VendorOutputFormat): VendorAnswer {
  const trimmed = raw.trim();
  if (format === 'text') {
    return { text: trimmed, parsed: false, reportedStatus: null, files: [] };
  }
  return extractCodexJsonl(trimmed);
}

/**
 * Read Codex's `--json` event stream.
 *
 * The documented shape is `{"method": "...", "params": {...}}` per line, with:
 *
 *  - `item/completed` where `params.item.type === 'agentMessage'` and
 *    `params.item.text` is the assistant's text;
 *  - `item/agentMessage/delta` where `params.delta` is a chunk, used only if no
 *    completed message ever arrives;
 *  - `turn/completed` where `params.turn.status` is the terminal status.
 *
 * Anything that does not match is skipped rather than treated as fatal: a
 * harness that prints a banner on line 1 must not lose its answer on line 40.
 */
function extractCodexJsonl(raw: string): VendorAnswer {
  if (raw === '') return { text: '', parsed: false, reportedStatus: null, files: [] };

  const completed: string[] = [];
  const deltas: string[] = [];
  const files = new Set<string>();
  let reportedStatus: string | null = null;
  let sawAnyEvent = false;

  for (const line of raw.split(/\r?\n/)) {
    const text = line.trim();
    if (text === '' || (text[0] !== '{' && text[0] !== '[')) continue;
    let event: unknown;
    try {
      event = JSON.parse(text);
    } catch {
      continue;
    }
    if (!isRecord(event)) continue;
    sawAnyEvent = true;

    const params = isRecord(event['params']) ? event['params'] : null;
    if (params === null) continue;
    const method = typeof event['method'] === 'string' ? event['method'] : '';

    // --- the answer ---------------------------------------------------------
    const item = isRecord(params['item']) ? params['item'] : null;
    if (item !== null) {
      const type = typeof item['type'] === 'string' ? item['type'] : '';
      if (type === 'agentMessage' && typeof item['text'] === 'string' && item['text'] !== '') {
        completed.push(item['text']);
      }
      collectPaths(item, files);
    }

    if (method === 'item/agentMessage/delta' && typeof params['delta'] === 'string') {
      deltas.push(params['delta']);
    }

    // --- the terminal status ------------------------------------------------
    const turn = isRecord(params['turn']) ? params['turn'] : null;
    if (turn !== null && typeof turn['status'] === 'string') reportedStatus = turn['status'];
  }

  if (completed.length > 0) {
    return {
      text: completed.join('\n\n').trim(),
      parsed: true,
      reportedStatus,
      files: [...files].sort(),
    };
  }

  // No completed message. A delta stream is the next-best answer, and the raw
  // text is the last resort - but only when the output really was an event
  // stream, because falling back on prose that merely started with `{` would
  // hand the model a wall of JSON.
  if (deltas.length > 0) {
    return { text: deltas.join('').trim(), parsed: true, reportedStatus, files: [...files].sort() };
  }
  if (sawAnyEvent) {
    return { text: raw.trim(), parsed: false, reportedStatus, files: [...files].sort() };
  }
  return { text: raw.trim(), parsed: false, reportedStatus: null, files: [] };
}

/**
 * Pull path-looking values out of an event object.
 *
 * Deliberately narrow: only known key names, only strings, and only values with
 * something path-like about them. A false positive puts a file in
 * `turn.wroteFiles` that nobody wrote, which would send a review loop back to a
 * producer that did not produce it - so being conservative is the right error.
 */
function collectPaths(node: Record<string, unknown>, into: Set<string>): void {
  for (const [key, value] of Object.entries(node)) {
    if (typeof value === 'string' && PATH_KEYS.includes(key) && looksLikePath(value)) {
      into.add(value);
      continue;
    }
    // One level of nesting covers `{ changes: [{ path }] }` and its relatives
    // without walking an arbitrary structure the vendor controls.
    if (Array.isArray(value)) {
      for (const entry of value) {
        if (isRecord(entry)) collectPaths(entry, into);
      }
    } else if (isRecord(value)) {
      collectPaths(value, into);
    }
  }
}

function looksLikePath(value: string): boolean {
  if (value === '' || value.length > 400) return false;
  if (value.startsWith('http://') || value.startsWith('https://')) return false;
  // A path has a separator or a dot-extension, and no newline.
  return /[\\/]/.test(value) || /\.[a-z0-9]{1,8}$/i.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
