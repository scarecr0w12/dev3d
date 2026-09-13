/**
 * Which hosts are allowed to be fetched, and how much of the answer is read.
 *
 * This began as `web_fetch`'s guard and now serves four callers — the two web
 * tools, plugin panel sources, and the marketplace's catalog and bundle downloads —
 * because they all had the same two gaps. It lives in `security/` rather than under
 * `tools/` for that reason: tool implementations import it, not the other way
 * round.
 *
 * The gaps:
 *
 *  - **No host check at all.** `web_fetch` validated only that the URL parsed and
 *    used `http:`/`https:`, so an employee could fetch
 *    `http://127.0.0.1:8787/api/state` and read the whole office state — memory
 *    record and run history included — through a tool that asks nobody. On a cloud
 *    VM the same primitive reaches `169.254.169.254` for instance credentials.
 *  - **`redirect: 'follow'`.** A 302 defeated any host check that was added later,
 *    and it does something worse than defeat it: the fetch spec rewrites a
 *    redirected POST into a GET, so a JSON-RPC handshake loses its body and the
 *    failure reports as a protocol error rather than as "your URL redirects".
 *    Redirects are followed by hand here, each hop re-checked, and the caller says
 *    how many are acceptable.
 *
 * ## What this does and does not defend against
 *
 * It refuses *addresses* that are not public: loopback, private ranges,
 * link-local (which covers the cloud metadata services), CGNAT, IPv6 unique-local
 * and unspecified. The check is applied to the literal IP the hostname resolves
 * to, not to the name, so `localhost`, `127.0.0.1`, `[::1]` and a
 * `metadata.google.internal` that resolves into link-local are all caught.
 *
 * What it cannot fully remove is **DNS rebinding**: a name that resolves to a
 * public address at check time and to a private one at connect time. Closing that
 * properly means connecting to the validated IP with the `Host` header set, which
 * Node's `fetch` does not expose. The residual risk is therefore real and
 * documented rather than hidden — but the ordinary cases, including the office's
 * own API on loopback, are refused.
 *
 * Callers that legitimately talk to a loopback service — an operator's local MCP
 * server, a marketplace being developed on localhost, a plugin author's dev panel
 * — pass their own `check`, or call `fetch` directly and say why at the call site.
 */

import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';

/** Hostnames that are never acceptable, whatever they resolve to. */
const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'localhost.localdomain',
  'metadata',
  'metadata.google.internal',
  'instance-data',
]);

/**
 * Private, loopback, link-local and otherwise non-public IPv4 ranges.
 *
 * `169.254.0.0/16` is the important one: it holds the AWS/GCP/Azure instance
 * metadata endpoints, which hand out credentials to anything that can reach
 * them.
 */
function isBlockedIpv4(ip: string): boolean {
  const parts = ip.split('.').map((p) => Number(p));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = parts as [number, number, number, number];
  if (a === 0) return true; // "this network"
  if (a === 10) return true; // private
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local, incl. cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 168) return true; // private
  if (a === 192 && b === 0) return true; // IETF protocol assignments, incl. 192.0.0.0/24
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a >= 224) return true; // multicast and reserved
  return false;
}

/** Loopback, unspecified, unique-local, link-local and multicast IPv6. */
function isBlockedIpv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === '::1' || lower === '::') return true;
  if (lower.startsWith('fe80')) return true; // link-local
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // unique-local
  if (lower.startsWith('ff')) return true; // multicast
  // IPv4-mapped (::ffff:127.0.0.1) is judged by the embedded address.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (mapped?.[1] !== undefined) return isBlockedIpv4(mapped[1]);
  return false;
}

/** Whether one resolved address is off limits. */
export function isBlockedAddress(ip: string): boolean {
  const version = isIP(ip);
  if (version === 4) return isBlockedIpv4(ip);
  if (version === 6) return isBlockedIpv6(ip);
  return true; // not an IP at all: refuse rather than guess
}

export interface HostCheck {
  ok: boolean;
  /** Why it was refused, phrased for a model to act on. */
  reason: string;
  /** The addresses it resolved to, for the message. */
  addresses: string[];
}

/**
 * Resolve a URL's host and refuse it if it can only reach a non-public address.
 *
 * A host that resolves to *both* a public and a private address is refused: the
 * connection could land on either, and there is no way to pin the choice through
 * `fetch`.
 */
export async function checkHostIsPublic(url: URL): Promise<HostCheck> {
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (BLOCKED_HOSTNAMES.has(host.toLowerCase())) {
    return { ok: false, reason: `"${host}" is not a public host.`, addresses: [] };
  }

  // A literal address needs no DNS.
  if (isIP(host) !== 0) {
    if (isBlockedAddress(host)) {
      return { ok: false, reason: `"${host}" is a private, loopback or link-local address.`, addresses: [host] };
    }
    return { ok: true, reason: '', addresses: [host] };
  }

  let addresses: string[];
  try {
    const records = await lookup(host, { all: true, verbatim: true });
    addresses = records.map((r) => r.address);
  } catch {
    // A name that does not resolve is not a policy refusal; the fetch will report
    // the failure with its own, more useful message.
    return { ok: true, reason: '', addresses: [] };
  }
  if (addresses.length === 0) return { ok: true, reason: '', addresses };

  const blocked = addresses.filter(isBlockedAddress);
  if (blocked.length > 0) {
    return {
      ok: false,
      reason:
        `"${host}" resolves to ${blocked.join(', ')}, which is a private, loopback or ` +
        'link-local address. Fetching it could reach this machine or a cloud metadata service.',
      addresses,
    };
  }
  return { ok: true, reason: '', addresses };
}

/**
 * Read at most `maxBytes` of a response body.
 *
 * `res.text()` used to concatenate the entire body before the 20,000-character
 * cap was applied — a measured +412 MB of RSS for a 400 MB response, on a 15 s
 * timeout, multiplied by `DEV3D_MAX_CONCURRENCY` (default 4). A large enough page
 * could take the orchestrator down and every run with it.
 */
export async function readCapped(
  resp: Response,
  maxBytes: number,
): Promise<{ text: string; truncated: boolean }> {
  // `content-length` is a hint, not a promise, so it is used as an early exit
  // rather than as the enforcement.
  const declared = Number(resp.headers.get('content-length') ?? '');
  const body = resp.body;
  if (body === null) {
    const text = await resp.text();
    return { text: text.slice(0, maxBytes), truncated: text.length > maxBytes };
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      total += value.byteLength;
      if (total >= maxBytes) {
        chunks.push(value.subarray(0, Math.max(0, maxBytes - (total - value.byteLength))));
        truncated = true;
        break;
      }
      chunks.push(value);
    }
  } finally {
    if (truncated) await reader.cancel().catch(() => {});
  }
  if (truncated && Number.isFinite(declared) && declared > maxBytes) {
    // Nothing extra to do; the flag already says so.
  }
  const merged = Buffer.concat(chunks.map((c) => Buffer.from(c)));
  return { text: merged.toString('utf8'), truncated };
}

/** The maximum bytes `web_fetch` will read from one response. */
export const MAX_FETCH_BYTES = 2_000_000;

/** How many redirects `web_fetch` will follow, re-checking the host each time. */
export const MAX_REDIRECTS = 5;

/**
 * The outcome of one guarded request.
 *
 * Three cases, kept distinct because they deserve different answers: a policy
 * refusal (do not retry, the address is off limits), a transport failure (the
 * network, worth reporting as such), and a response.
 */
export type GuardedFetchResult =
  | { ok: true; response: Response; finalUrl: URL }
  | { ok: false; refused: true; url: string; reason: string }
  | { ok: false; refused: false; url: string; error: string };

export interface GuardedFetchOptions {
  headers: Record<string, string>;
  timeoutMs: number;
  /**
   * How many redirects to follow. Defaults to `MAX_REDIRECTS`; `0` means a
   * redirect is refused outright, which is right when the configured URL is meant
   * to be *the* endpoint (a JSON-RPC transport, a catalog) rather than a name that
   * may move.
   */
  maxRedirects?: number;
  /** Overridden by a test, which must not reach the network. */
  fetchImpl?: typeof fetch;
  check?: (url: URL) => Promise<HostCheck>;
}

/**
 * Fetch a URL, checking every host it actually connects to.
 *
 * `redirect: 'follow'` made the guard defeatable by a 302: the URL a tool asked
 * for is checked, and the URL it *lands on* never is. This follows redirects by
 * hand, re-checking each hop, so `https://public.example/x` that answers
 * `302 http://127.0.0.1:8787/api/state` is refused at hop two.
 *
 * Both web tools use this. They did not before — `web_search` kept a bare
 * `fetch(..., {redirect: 'follow'})` and an unbounded `res.text()` long after
 * `web_fetch` was fixed, which is what happens when a fix is applied at a call
 * site instead of at the choke point.
 */
export async function fetchGuarded(url: URL, options: GuardedFetchOptions): Promise<GuardedFetchResult> {
  const doFetch = options.fetchImpl ?? fetch;
  const check = options.check ?? checkHostIsPublic;
  const maxRedirects = options.maxRedirects ?? MAX_REDIRECTS;

  let current = url;
  for (let hops = 0; ; hops += 1) {
    const host = await check(current);
    if (!host.ok) return { ok: false, refused: true, url: current.href, reason: host.reason };
    if (hops > maxRedirects) {
      return {
        ok: false,
        refused: true,
        url: url.href,
        reason:
          maxRedirects === 0
            ? 'the endpoint redirected, and a redirect is not accepted here'
            : `more than ${maxRedirects} redirects`,
      };
    }

    let attempt: Response;
    try {
      attempt = await doFetch(current, {
        headers: options.headers,
        redirect: 'manual',
        signal: AbortSignal.timeout(options.timeoutMs),
      });
    } catch (error) {
      return { ok: false, refused: false, url: current.href, error: errMsg(error) };
    }

    const location = attempt.headers.get('location');
    if (attempt.status < 300 || attempt.status >= 400 || location === null) {
      return { ok: true, response: attempt, finalUrl: current };
    }

    let next: URL;
    try {
      next = new URL(location, current);
    } catch {
      return { ok: false, refused: false, url: current.href, error: `the redirect target ${JSON.stringify(location)} is not a URL` };
    }
    if (next.protocol !== 'http:' && next.protocol !== 'https:') {
      return { ok: false, refused: false, url: current.href, error: `the redirect target ${next.protocol}// is not http(s)` };
    }
    current = next;
  }
}

function errMsg(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
