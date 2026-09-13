/**
 * Web tools: fetch a single URL and search the web.
 *
 * Neither tool may ever throw - a network failure, a non-HTTP URL, or an
 * unparseable response is an `ok: false` result with an actionable message, so
 * an employee can honestly say "I could not reach the network" instead of
 * inventing sources.
 */

import type { Tool, ToolContext } from './types.ts';
import { MAX_FETCH_BYTES, fetchGuarded, readCapped } from '../security/webGuard.ts';

const FETCH_TIMEOUT_MS = 15_000;
const MAX_CONTENT_CHARS = 20_000;
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function fail(content: string, preview = 'Error'): { ok: false; content: string; preview: string; affectsPaths: [] } {
  return { ok: false, content, preview, affectsPaths: [] };
}

function toInt(v: unknown, fallback: number): number {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.trunc(v);
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    if (Number.isFinite(n)) return Math.trunc(n);
  }
  return fallback;
}

function cap(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, d: string) => {
      const n = Number(d);
      return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '';
    });
}

function stripTags(s: string): string {
  return decodeEntities(s.replace(/<[^>]*>/g, ''));
}

function stripHtml(html: string): string {
  let s = html;
  s = s.replace(/<script[\s\S]*?<\/script>/gi, ' ');
  s = s.replace(/<style[\s\S]*?<\/style>/gi, ' ');
  s = s.replace(/<!--[\s\S]*?-->/g, ' ');
  s = s.replace(/<[^>]+>/g, ' ');
  s = decodeEntities(s);
  return s.replace(/\s+/g, ' ').trim();
}

// ---------------------------------------------------------------------------
// web_fetch
// ---------------------------------------------------------------------------

const webFetchTool: Tool = {
  name: 'web_fetch',
  description:
    'Fetch a single http/https URL and return its text. HTML is stripped of ' +
    'scripts, styles and tags and collapsed into readable text. Output is capped at 20000 characters.',
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'Absolute http:// or https:// URL to fetch.' },
    },
    required: ['url'],
    additionalProperties: false,
  },
  run: async (args, _ctx) => {
    if (typeof args.url !== 'string' || args.url === '') {
      return fail('web_fetch requires a non-empty "url" string.');
    }
    let parsed: URL;
    try {
      parsed = new URL(args.url);
    } catch {
      return fail(`"${args.url}" is not a valid URL.`);
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return fail(`Only http:// and https:// URLs are allowed (got ${parsed.protocol}//).`);
    }

    try {
      // Redirects are followed by hand inside `fetchGuarded` so that every hop is
      // checked: with `redirect: 'follow'`, a public URL could 302 straight to
      // loopback and the guard would never see it.
      const attempt = await fetchGuarded(parsed, {
        headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,text/plain,*/*' },
        timeoutMs: FETCH_TIMEOUT_MS,
      });
      if (!attempt.ok) {
        if (attempt.refused) {
          return fail(
            `web_fetch refused ${attempt.url}: ${attempt.reason} ` +
              'Only public internet addresses may be fetched.',
            'Refused a non-public address',
          );
        }
        return fail(
          `Network request to ${args.url} failed: ${attempt.error}. Check the URL and connectivity, then try again.`,
          'Network error',
        );
      }
      const res = attempt.response;
      const current = attempt.finalUrl;

      const raw = await readCapped(res, MAX_FETCH_BYTES);
      const contentType = res.headers.get('content-type') ?? '';
      const isHtml = contentType.toLowerCase().includes('text/html');
      const body = cap(isHtml ? stripHtml(raw.text) : raw.text, MAX_CONTENT_CHARS);
      const finalUrl = res.url || current.href;
      const sizeNote = raw.truncated
        ? `\n\n[truncated: the response exceeded ${Math.round(MAX_FETCH_BYTES / 1000)} KB and only the beginning was read]`
        : '';
      return {
        ok: res.ok,
        content: `Status: ${res.status} ${res.statusText}\nFinal URL: ${finalUrl}\n\n${body}${sizeNote}`,
        preview: `Status ${res.status} (${finalUrl})`,
        affectsPaths: [],
      };
    } catch (e) {
      return fail(
        `Network request to ${args.url} failed: ${errMsg(e)}. Check the URL and connectivity, then try again.`,
        'Network error',
      );
    }
  },
};

// ---------------------------------------------------------------------------
// web_search
// ---------------------------------------------------------------------------

function decodeUddg(href: string): string | null {
  const m = href.match(/[?&]uddg=([^&]+)/);
  if (!m || !m[1]) return null;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return m[1];
  }
}

interface SearchHit {
  title: string;
  url: string;
  snippet: string;
}

function parseDuckDuckGo(html: string, max: number): SearchHit[] {
  const hits: SearchHit[] = [];
  const anchors = html.matchAll(
    /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi,
  );
  const snippets = html.matchAll(
    /<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/gi,
  );

  const anchorArr = [...anchors];
  const snippetArr = [...snippets];

  for (let i = 0; i < anchorArr.length && hits.length < max; i += 1) {
    const anchor = anchorArr[i];
    if (!anchor) continue;
    const href = anchor[1] ?? '';
    const title = stripTags(anchor[2] ?? '').replace(/\s+/g, ' ').trim();
    const url = decodeUddg(href);
    if (!url) continue; // ad / redirect / non-uddg row
    if (title === '') continue;
    const snippet = stripTags(snippetArr[i]?.[1] ?? '').replace(/\s+/g, ' ').trim();
    hits.push({ title, url, snippet });
  }
  return hits;
}

const webSearchTool: Tool = {
  name: 'web_search',
  description:
    'Search the web (via DuckDuckGo HTML) and return a numbered list of titles, ' +
    'URLs and snippets. Returns an error result if the network is unreachable or parsing fails.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search query.' },
      maxResults: { type: 'number', description: 'Maximum results to return (default 5).' },
    },
    required: ['query'],
    additionalProperties: false,
  },
  run: async (args, _ctx) => {
    if (typeof args.query !== 'string' || args.query.trim() === '') {
      return fail('web_search requires a non-empty "query" string.');
    }
    const maxResults = Math.min(Math.max(toInt(args.maxResults, 5), 1), 20);

    let url: string;
    try {
      url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(args.query)}`;
    } catch {
      return fail('web_search: the query could not be URL-encoded.', 'Web search unavailable');
    }
    try {
      // The same guard and the same byte ceiling as `web_fetch`, because this is
      // the same fetch: it kept `redirect: 'follow'` and an unbounded `res.text()`
      // long after `web_fetch` was fixed, and the buffering half is exactly as
      // reachable from here — the query is the model's, and the response is not.
      const attempt = await fetchGuarded(new URL(url), {
        headers: { 'User-Agent': USER_AGENT, Accept: 'text/html' },
        timeoutMs: FETCH_TIMEOUT_MS,
      });
      if (!attempt.ok) {
        const why = attempt.refused ? `refused ${attempt.url}: ${attempt.reason}` : `network error (${attempt.error})`;
        return fail(
          `Web search was unavailable (${why}). The employee should say "I could not reach the network" rather than inventing sources.`,
          'Web search unavailable',
        );
      }
      const res = attempt.response;
      if (!res.ok) {
        return fail(
          `Web search was unavailable (DuckDuckGo returned HTTP ${res.status}).`,
          'Web search unavailable',
        );
      }
      const { text: html } = await readCapped(res, MAX_FETCH_BYTES);
      const hits = parseDuckDuckGo(html, maxResults);
      if (hits.length === 0) {
        return fail(
          'Web search was unavailable: the search engine returned no parseable results.',
          'Web search unavailable',
        );
      }
      const content = hits
        .map((h, i) => `${i + 1}. ${h.title} — ${h.url}${h.snippet ? `\n   ${h.snippet}` : ''}`)
        .join('\n\n');
      return {
        ok: true,
        content,
        preview: `${hits.length} result(s) for "${args.query}"`,
        affectsPaths: [],
      };
    } catch (e) {
      return fail(
        `Web search was unavailable: network error (${errMsg(e)}). The employee should say "I could not reach the network" rather than inventing sources.`,
        'Web search unavailable',
      );
    }
  },
};

export function createWebTools(): Tool[] {
  return [webFetchTool, webSearchTool];
}
