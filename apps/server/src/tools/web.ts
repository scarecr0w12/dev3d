/**
 * Web tools: fetch a single URL and search the web.
 *
 * Neither tool may ever throw - a network failure, a non-HTTP URL, or an
 * unparseable response is an `ok: false` result with an actionable message, so
 * an employee can honestly say "I could not reach the network" instead of
 * inventing sources.
 */

import type { Tool, ToolContext } from './types.ts';

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
      const res = await fetch(parsed, {
        headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,text/plain,*/*' },
        redirect: 'follow',
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      const rawBody = await res.text();
      const contentType = res.headers.get('content-type') ?? '';
      const isHtml = contentType.toLowerCase().includes('text/html');
      const body = cap(isHtml ? stripHtml(rawBody) : rawBody, MAX_CONTENT_CHARS);
      const finalUrl = res.url || args.url;
      return {
        ok: res.ok,
        content: `Status: ${res.status} ${res.statusText}\nFinal URL: ${finalUrl}\n\n${body}`,
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
      const res = await fetch(url, {
        headers: { 'User-Agent': USER_AGENT, Accept: 'text/html' },
        redirect: 'follow',
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!res.ok) {
        return fail(
          `Web search was unavailable (DuckDuckGo returned HTTP ${res.status}).`,
          'Web search unavailable',
        );
      }
      const html = await res.text();
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
